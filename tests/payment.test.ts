import ShimmieTestStack from "shimmiestack/shimmieteststack";
import { BookingCommand } from "../src/booking/command";
import { BookingModel } from "../src/booking/model";
import { EarningsModel } from "../src/entertainer/model";
import { PaymentRecordedEvent, RecordModels, SubscribeModels } from "../src/events";

function makeStack() {
  const stack = ShimmieTestStack<RecordModels, SubscribeModels>();
  const bookingModel = BookingModel(stack);
  const earningsModel = EarningsModel(stack);
  stack.mountTest(
    BookingCommand(stack, bookingModel, earningsModel),
    "/bookings",
  );
  return { stack, bookingModel, earningsModel };
}

const aBooking = {
  venueId: "the-espy",
  entertainerId: "ent-1",
  entertainerName: "The Amplifiers",
  feeCents: 45000,
  startsAt: "2030-01-10T20:00:00.000Z",
};

const aPayment: PaymentRecordedEvent = {
  paymentId: "pay-1",
  bookingId: "abc-123",
  amountCents: 10000,
  paidAt: "2030-01-01T10:00:00.000Z",
};

describe("the payment recorded event", () => {
  it("should be delivered to subscribers with its payload, stream and meta", async () => {
    const { stack } = makeStack();
    const received: any[] = [];
    stack.subscribe("PAYMENT_RECORDED_EVENT", (event) => {
      received.push(event);
    });

    await stack.recordUncheckedEvent({
      streamId: `booking-${aPayment.bookingId}`,
      eventName: "PAYMENT_RECORDED_EVENT",
      eventData: aPayment,
      meta: { userAgent: "test", user: "tester", date: 1234 },
    });

    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual(aPayment);
    expect(received[0].streamId).toBe("booking-abc-123");
    expect(received[0].meta).toMatchObject({ user: "tester", date: 1234 });
  });

  it("should deliver every payment for a booking, in order", async () => {
    const { stack } = makeStack();
    const received: PaymentRecordedEvent[] = [];
    stack.subscribe("PAYMENT_RECORDED_EVENT", (event) => {
      received.push(event.data);
    });

    const deposit = { ...aPayment, paymentId: "pay-deposit", amountCents: 5000 };
    const balance = { ...aPayment, paymentId: "pay-balance", amountCents: 40000 };
    for (const payment of [deposit, balance]) {
      await stack.recordUncheckedEvent({
        streamId: `booking-${payment.bookingId}`,
        eventName: "PAYMENT_RECORDED_EVENT",
        eventData: payment,
        meta: { userAgent: "test", user: "tester", date: Date.now() },
      });
    }

    expect(received.map((p) => p.paymentId)).toEqual([
      "pay-deposit",
      "pay-balance",
    ]);
  });

  // Compile-time only: ts-jest fails the suite if these stop being errors.
  it("should reject malformed payloads at compile time", () => {
    const neverCalled = () => {
      const { stack } = makeStack();
      const meta = { userAgent: "test", user: "tester", date: 0 };
      stack.recordUncheckedEvent({
        streamId: "s",
        eventName: "PAYMENT_RECORDED_EVENT",
        // @ts-expect-error amountCents is required
        eventData: { paymentId: "p", bookingId: "b", paidAt: "2030-01-01" },
        meta,
      });
      stack.recordUncheckedEvent({
        streamId: "s",
        eventName: "PAYMENT_RECORDED_EVENT",
        eventData: {
          paymentId: "p",
          bookingId: "b",
          // @ts-expect-error amountCents must be a number
          amountCents: "100",
          paidAt: "2030-01-01",
        },
        meta,
      });
    };
    expect(neverCalled).toBeDefined();
  });
});

const aPaymentBody = {
  paymentId: "pay-1",
  amountCents: 10000,
  paidAt: "2026-01-01T10:00:00.000Z",
};

describe("recording a payment", () => {
  it("should record the payment against the booking", async () => {
    const { stack, earningsModel } = makeStack();

    const created = await stack.testPost({
      path: "/bookings",
      body: aBooking,
      expectedResponseCode: 201,
    });
    const { bookingId } = created.body;

    const recorded = await stack.testPost({
      path: `/bookings/${bookingId}/payments`,
      body: aPaymentBody,
      expectedResponseCode: 201,
    });
    expect(recorded.body.paymentId).toBe("pay-1");

    expect(earningsModel.getPayment("pay-1")).toEqual({
      ...aPaymentBody,
      bookingId,
    });
  });

  it("should accept several partial payments for one booking", async () => {
    const { stack, earningsModel } = makeStack();

    const created = await stack.testPost({
      path: "/bookings",
      body: aBooking,
      expectedResponseCode: 201,
    });
    const { bookingId } = created.body;

    for (const paymentId of ["pay-deposit", "pay-balance"]) {
      await stack.testPost({
        path: `/bookings/${bookingId}/payments`,
        body: { ...aPaymentBody, paymentId },
        expectedResponseCode: 201,
      });
    }

    expect(earningsModel.getEarningsForEntertainer("ent-1").totalPaidCents).toBe(
      20000,
    );
  });

  it("should accept a payment for a cancelled booking", async () => {
    const { stack, earningsModel } = makeStack();

    const created = await stack.testPost({
      path: "/bookings",
      body: aBooking,
      expectedResponseCode: 201,
    });
    const { bookingId } = created.body;
    await stack.testPost({
      path: `/bookings/${bookingId}/cancel`,
      body: { reason: "venue double-booked" },
      expectedResponseCode: 200,
    });

    await stack.testPost({
      path: `/bookings/${bookingId}/payments`,
      body: aPaymentBody,
      expectedResponseCode: 201,
    });

    expect(
      earningsModel.getEarningsForEntertainer("ent-1").totalPaidOnCancelledCents,
    ).toBe(10000);
  });

  it("should return 404 for a booking that does not exist", async () => {
    const { stack, earningsModel } = makeStack();

    await stack.testPost({
      path: "/bookings/not-a-real-booking/payments",
      body: aPaymentBody,
      expectedResponseCode: 404,
    });
    expect(earningsModel.getPayment("pay-1")).toBeUndefined();
  });

  it.each([
    ["a missing paymentId", { paymentId: undefined }],
    ["a missing amount", { amountCents: undefined }],
    ["a zero amount", { amountCents: 0 }],
    ["a negative amount", { amountCents: -100 }],
    ["a fractional amount", { amountCents: 100.5 }],
    ["a string amount", { amountCents: "100" }],
    ["a missing paidAt", { paidAt: undefined }],
    ["an invalid paidAt", { paidAt: "not-a-date" }],
    ["a future paidAt", { paidAt: "2999-01-01T00:00:00.000Z" }],
  ])("should return 400 for %s", async (_, override) => {
    const { stack, earningsModel } = makeStack();

    const created = await stack.testPost({
      path: "/bookings",
      body: aBooking,
      expectedResponseCode: 201,
    });
    const { bookingId } = created.body;

    await stack.testPost({
      path: `/bookings/${bookingId}/payments`,
      body: { ...aPaymentBody, ...override },
      expectedResponseCode: 400,
    });
    expect(earningsModel.getEarningsForEntertainer("ent-1").totalPaidCents).toBe(
      0,
    );
  });

  it("should return 409 and not record again when a paymentId already exists", async () => {
    const { stack, earningsModel } = makeStack();

    const created = await stack.testPost({
      path: "/bookings",
      body: aBooking,
      expectedResponseCode: 201,
    });
    const { bookingId } = created.body;

    await stack.testPost({
      path: `/bookings/${bookingId}/payments`,
      body: aPaymentBody,
      expectedResponseCode: 201,
    });
    await stack.testPost({
      path: `/bookings/${bookingId}/payments`,
      body: aPaymentBody,
      expectedResponseCode: 409,
    });
    await stack.testPost({
      path: `/bookings/${bookingId}/payments`,
      body: { ...aPaymentBody, amountCents: 99999 },
      expectedResponseCode: 409,
    });

    expect(stack.recordUncheckedEvent).toHaveBeenCalledTimes(2);
    expect(earningsModel.getEarningsForEntertainer("ent-1").totalPaidCents).toBe(
      10000,
    );
  });
});
