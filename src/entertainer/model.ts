import { StackType } from "shimmiestack";
import { BookingStatus } from "../booking/model";
import { PaymentRecordedEvent, RecordModels, SubscribeModels } from "../events";

export type Payment = Omit<PaymentRecordedEvent, "bookingId">;

interface EarningsBooking {
  bookingId: string;
  entertainerId: string;
  venueId: string;
  startsAt: string;
  feeCents: number;
  status: BookingStatus;
  payments: Payment[];
}

export interface BookingEarnings {
  bookingId: string;
  venueId: string;
  startsAt: string;
  status: BookingStatus;
  feeCents: number;
  paidCents: number;
  outstandingCents: number;
  overpaidCents: number;
  payments: Payment[];
}

export interface EarningsSummary {
  entertainerId: string;
  totalPaidCents: number;
  totalPaidOnCancelledCents: number;
  totalFeesCents: number;
  totalOutstandingCents: number;
  bookings: BookingEarnings[];
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function toBookingEarnings(booking: EarningsBooking): BookingEarnings {
  const { payments, feeCents, status } = booking;
  const paidCents = sum(payments.map((p) => p.amountCents));
  const cancelled = status === "cancelled";
  return {
    bookingId: booking.bookingId,
    venueId: booking.venueId,
    startsAt: booking.startsAt,
    status,
    feeCents,
    paidCents,
    outstandingCents: cancelled ? 0 : Math.max(feeCents - paidCents, 0),
    overpaidCents: cancelled ? paidCents : Math.max(paidCents - feeCents, 0),
    payments,
  };
}

export function EarningsModel(stack: StackType<RecordModels, SubscribeModels>) {
  const bookingsById = new Map<string, EarningsBooking>();
  const paymentsById = new Map<string, PaymentRecordedEvent>();

  // Handle booking confirmed
  // Subscribe to booking confirmed events and add them to the bookingsById map
  stack.subscribe("BOOKING_CONFIRMED_EVENT", (event) => {
    const { bookingId, entertainerId, venueId, startsAt, feeCents } =
      event.data;
    bookingsById.set(bookingId, {
      bookingId,
      entertainerId,
      venueId,
      startsAt,
      feeCents,
      status: "booked",
      payments: [],
    });
  });

  stack.subscribe("BOOKING_CANCELLED_EVENT", (event) => {
    const booking = bookingsById.get(event.data.bookingId);
    if (!booking) {
      return;
    }
    bookingsById.set(booking.bookingId, { ...booking, status: "cancelled" });
  });

  // Handle payment recorded events
  // Subscribe to payment recorded events
  // Check if the payment is for a known booking and hasn't been recorded before
  // Record the payment and update the booking's payments array
  stack.subscribe("PAYMENT_RECORDED_EVENT", (event) => {
    const { paymentId, bookingId, amountCents, paidAt } = event.data;
    const booking = bookingsById.get(bookingId);
    if (!booking || paymentsById.has(paymentId)) {
      return;
    }
    paymentsById.set(paymentId, event.data);
    bookingsById.set(bookingId, {
      ...booking,
      payments: [...booking.payments, { paymentId, amountCents, paidAt }],
    });
  });

  return {
    getPayment: (paymentId: string): PaymentRecordedEvent | undefined =>
      paymentsById.get(paymentId),

    // Handle earnings summary for an entertainer
    getEarningsForEntertainer: (entertainerId: string): EarningsSummary => {
      const bookings = Array.from(bookingsById.values())
        .filter((booking) => booking.entertainerId === entertainerId)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
        .map(toBookingEarnings);
      const active = bookings.filter((b) => b.status === "booked");
      const cancelled = bookings.filter((b) => b.status === "cancelled");

      return {
        entertainerId,
        totalPaidCents: sum(bookings.map((b) => b.paidCents)),
        totalPaidOnCancelledCents: sum(cancelled.map((b) => b.paidCents)),
        totalFeesCents: sum(active.map((b) => b.feeCents)),
        totalOutstandingCents: sum(active.map((b) => b.outstandingCents)),
        bookings,
      };
    },
  };
}

export type EarningsModelType = ReturnType<typeof EarningsModel>;
