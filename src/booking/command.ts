/** Write side: validate, then record events. State updates via the model. */
import { randomUUID } from "crypto";
import { Request, Response, Router, StackType } from "shimmiestack";
import { EarningsModelType } from "../entertainer/model";
import {
  BookingConfirmedEvent,
  PaymentRecordedEvent,
  RecordModels,
  SubscribeModels,
} from "../events";
import { BookingModelType } from "./model";

/** Event metadata: who, where, when. */
function metaFrom(req: Request) {
  return {
    userAgent: req.get("user-agent") ?? "unknown",
    user: req.get("x-user-id") ?? "anonymous",
    date: Date.now(),
  };
}

export function BookingCommand(
  stack: StackType<RecordModels, SubscribeModels>,
  bookingModel: BookingModelType,
  earningsModel: EarningsModelType,
): Router {
  const router = Router();

  router.post(
    "/",
    async (
      req: Request<{}, {}, BookingConfirmedEvent>,
      res: Response<{ bookingId: string } | { error: string }>,
    ) => {
      const { venueId, entertainerId, entertainerName, feeCents, startsAt } =
        req.body;

      if (!venueId || !entertainerId || !entertainerName || !startsAt) {
        return res.status(400).json({
          error:
            "venueId, entertainerId, entertainerName and startsAt are required",
        });
      }
      if (!Number.isInteger(feeCents) || feeCents < 0) {
        return res
          .status(400)
          .json({ error: "feeCents must be a non-negative integer" });
      }
      if (Number.isNaN(Date.parse(startsAt))) {
        return res
          .status(400)
          .json({ error: "startsAt must be an ISO-8601 datetime" });
      }

      const bookingId = randomUUID();

      // Unchecked = no optimistic concurrency on stream version.
      await stack.recordUncheckedEvent({
        streamId: `booking-${bookingId}`,
        eventName: "BOOKING_CONFIRMED_EVENT",
        eventData: {
          bookingId,
          venueId,
          entertainerId,
          entertainerName,
          feeCents,
          startsAt,
        },
        meta: metaFrom(req),
      });

      return res.status(201).json({ bookingId });
    },
  );

  router.post(
    "/:bookingId/cancel",
    async (
      req: Request<{ bookingId: string }, {}, { reason: string }>,
      res: Response<undefined | { error: string }>,
    ) => {
      const { bookingId } = req.params;
      const reason = req.body?.reason;

      if (!reason) {
        return res.status(400).json({ error: "reason is required" });
      }

      const booking = bookingModel.getBooking(bookingId);
      if (!booking) {
        return res
          .status(404)
          .json({ error: `no booking with id ${bookingId}` });
      }
      if (booking.status === "cancelled") {
        return res.status(409).json({ error: "booking is already cancelled" });
      }

      await stack.recordUncheckedEvent({
        streamId: `booking-${bookingId}`,
        eventName: "BOOKING_CANCELLED_EVENT",
        eventData: { bookingId, reason },
        meta: metaFrom(req),
      });

      return res.sendStatus(200);
    },
  );

  // Endpoint for incoming payments
  // Check the payload is valid before recording the payment
  // Check the booking exists
  // Check the payment has not already been recorded
  router.post(
    "/:bookingId/payments",
    async (
      req: Request<{ bookingId: string }, {}, Omit<PaymentRecordedEvent, "bookingId">>,
      res: Response<{ paymentId: string } | { error: string }>,
    ) => {
      const { bookingId } = req.params;
      const { paymentId, amountCents, paidAt } = req.body ?? {};

      if (!paymentId) {
        return res.status(400).json({ error: "paymentId is required" });
      }
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        return res
          .status(400)
          .json({ error: "amountCents must be a positive integer" });
      }
      if (!paidAt || Number.isNaN(Date.parse(paidAt))) {
        return res
          .status(400)
          .json({ error: "paidAt must be an ISO-8601 datetime" });
      }
      if (Date.parse(paidAt) > Date.now()) {
        return res.status(400).json({ error: "paidAt cannot be in the future" });
      }

      if (!bookingModel.getBooking(bookingId)) {
        return res
          .status(404)
          .json({ error: `no booking with id ${bookingId}` });
      }

      if (earningsModel.getPayment(paymentId)) {
        return res
          .status(409)
          .json({ error: `payment ${paymentId} already recorded` });
      }

      await stack.recordUncheckedEvent({
        streamId: `booking-${bookingId}`,
        eventName: "PAYMENT_RECORDED_EVENT",
        eventData: { paymentId, bookingId, amountCents, paidAt },
        meta: metaFrom(req),
      });

      return res.status(201).json({ paymentId });
    },
  );

  return router;
}
