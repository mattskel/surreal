import ShimmieTestStack from "shimmiestack/shimmieteststack";
import { EarningsModel } from "../src/entertainer/model";
import {
  BookingConfirmedEvent,
  PaymentRecordedEvent,
  RecordModels,
  SubscribeModels,
} from "../src/events";

const meta = { userAgent: "test", user: "tester", date: 0 };

function makeStack() {
  const stack = ShimmieTestStack<RecordModels, SubscribeModels>();
  const earningsModel = EarningsModel(stack);

  const confirm = (booking: Partial<BookingConfirmedEvent> & { bookingId: string }) =>
    stack.recordUncheckedEvent({
      streamId: `booking-${booking.bookingId}`,
      eventName: "BOOKING_CONFIRMED_EVENT",
      eventData: { ...aBooking, ...booking },
      meta,
    });

  const cancel = (bookingId: string) =>
    stack.recordUncheckedEvent({
      streamId: `booking-${bookingId}`,
      eventName: "BOOKING_CANCELLED_EVENT",
      eventData: { bookingId, reason: "venue double-booked" },
      meta,
    });

  const pay = (payment: PaymentRecordedEvent) =>
    stack.recordUncheckedEvent({
      streamId: `booking-${payment.bookingId}`,
      eventName: "PAYMENT_RECORDED_EVENT",
      eventData: payment,
      meta,
    });

  return { earningsModel, confirm, cancel, pay };
}

const aBooking: BookingConfirmedEvent = {
  bookingId: "b-1",
  venueId: "the-espy",
  entertainerId: "ent-1",
  entertainerName: "The Amplifiers",
  feeCents: 45000,
  startsAt: "2030-01-10T20:00:00.000Z",
};

const aPayment = (
  paymentId: string,
  bookingId: string,
  amountCents: number,
): PaymentRecordedEvent => ({
  paymentId,
  bookingId,
  amountCents,
  paidAt: "2026-01-01T10:00:00.000Z",
});

describe("the earnings model", () => {
  it("should return an empty summary for an entertainer with no bookings", () => {
    const { earningsModel } = makeStack();

    expect(earningsModel.getEarningsForEntertainer("ent-unknown")).toEqual({
      entertainerId: "ent-unknown",
      totalPaidCents: 0,
      totalPaidOnCancelledCents: 0,
      totalFeesCents: 0,
      totalOutstandingCents: 0,
      bookings: [],
    });
  });

  it("should show the full fee outstanding for a booking with no payments", async () => {
    const { earningsModel, confirm } = makeStack();
    await confirm({ bookingId: "b-1" });

    const summary = earningsModel.getEarningsForEntertainer("ent-1");
    expect(summary).toMatchObject({
      totalPaidCents: 0,
      totalFeesCents: 45000,
      totalOutstandingCents: 45000,
    });
    expect(summary.bookings).toEqual([
      expect.objectContaining({
        bookingId: "b-1",
        status: "booked",
        feeCents: 45000,
        paidCents: 0,
        outstandingCents: 45000,
        overpaidCents: 0,
        payments: [],
      }),
    ]);
  });

  it("should add up partial payments against a booking", async () => {
    const { earningsModel, confirm, pay } = makeStack();
    await confirm({ bookingId: "b-1" });
    await pay(aPayment("pay-deposit", "b-1", 10000));
    await pay(aPayment("pay-balance", "b-1", 20000));

    const [booking] = earningsModel.getEarningsForEntertainer("ent-1").bookings;
    expect(booking).toMatchObject({
      paidCents: 30000,
      outstandingCents: 15000,
      overpaidCents: 0,
    });
    expect(booking.payments.map((p) => p.paymentId)).toEqual([
      "pay-deposit",
      "pay-balance",
    ]);
  });

  it("should total across bookings, soonest first, and exclude other entertainers", async () => {
    const { earningsModel, confirm, pay } = makeStack();
    await confirm({ bookingId: "b-later", startsAt: "2030-03-01T20:00:00.000Z" });
    await confirm({
      bookingId: "b-sooner",
      startsAt: "2030-02-01T20:00:00.000Z",
      feeCents: 30000,
    });
    await confirm({ bookingId: "b-other", entertainerId: "ent-2" });
    await pay(aPayment("pay-1", "b-later", 45000));
    await pay(aPayment("pay-2", "b-sooner", 10000));
    await pay(aPayment("pay-3", "b-other", 99999));

    const summary = earningsModel.getEarningsForEntertainer("ent-1");
    expect(summary).toMatchObject({
      totalPaidCents: 55000,
      totalFeesCents: 75000,
      totalOutstandingCents: 20000,
    });
    expect(summary.bookings.map((b) => b.bookingId)).toEqual([
      "b-sooner",
      "b-later",
    ]);
  });

  it("should flag an overpayment without counting it as outstanding", async () => {
    const { earningsModel, confirm, pay } = makeStack();
    await confirm({ bookingId: "b-1" });
    await pay(aPayment("pay-1", "b-1", 50000));

    const summary = earningsModel.getEarningsForEntertainer("ent-1");
    expect(summary.totalOutstandingCents).toBe(0);
    expect(summary.bookings[0]).toMatchObject({
      paidCents: 50000,
      outstandingCents: 0,
      overpaidCents: 5000,
    });
  });

  it("should keep payments on cancelled bookings in the total and flag them", async () => {
    const { earningsModel, confirm, cancel, pay } = makeStack();
    await confirm({ bookingId: "b-cancelled" });
    await confirm({ bookingId: "b-active", feeCents: 30000 });
    await pay(aPayment("pay-deposit", "b-cancelled", 10000));
    await cancel("b-cancelled");
    await pay(aPayment("pay-late", "b-cancelled", 5000));

    const summary = earningsModel.getEarningsForEntertainer("ent-1");
    expect(summary).toMatchObject({
      totalPaidCents: 15000,
      totalPaidOnCancelledCents: 15000,
      totalFeesCents: 30000,
      totalOutstandingCents: 30000,
    });
    expect(
      summary.bookings.find((b) => b.bookingId === "b-cancelled"),
    ).toMatchObject({
      status: "cancelled",
      paidCents: 15000,
      outstandingCents: 0,
      overpaidCents: 15000,
    });
  });

  it("should count a repeated paymentId only once", async () => {
    const { earningsModel, confirm, pay } = makeStack();
    await confirm({ bookingId: "b-1" });
    await pay(aPayment("pay-1", "b-1", 10000));
    await pay(aPayment("pay-1", "b-1", 10000));

    expect(earningsModel.getEarningsForEntertainer("ent-1").totalPaidCents).toBe(
      10000,
    );
  });

  it("should ignore a payment for an unknown booking", async () => {
    const { earningsModel, pay } = makeStack();
    await pay(aPayment("pay-1", "no-such-booking", 10000));

    expect(earningsModel.getPayment("pay-1")).toBeUndefined();
  });

  it("should look up a recorded payment by id", async () => {
    const { earningsModel, confirm, pay } = makeStack();
    await confirm({ bookingId: "b-1" });
    await pay(aPayment("pay-1", "b-1", 10000));

    expect(earningsModel.getPayment("pay-1")).toEqual(
      aPayment("pay-1", "b-1", 10000),
    );
    expect(earningsModel.getPayment("pay-2")).toBeUndefined();
  });
});
