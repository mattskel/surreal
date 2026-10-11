import { Request, Response, Router } from "shimmiestack";
import { EarningsModelType, EarningsSummary } from "./model";

export function EntertainerQuery(earningsModel: EarningsModelType): Router {
  const router = Router();

  router.get(
    "/:id/earnings",
    (req: Request<{ id: string }>, res: Response<EarningsSummary>) => {
      return res
        .status(200)
        .json(earningsModel.getEarningsForEntertainer(req.params.id));
    },
  );

  return router;
}
