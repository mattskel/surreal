import ShimmieTestStack from "shimmiestack/shimmieteststack";
import { PaymentRecordedEvent, RecordModels, SubscribeModels } from "../src/events";

function makeStack() {
  const stack = ShimmieTestStack<RecordModels, SubscribeModels>();
  return { stack };
}

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
