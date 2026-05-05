import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Ejecuta sync inbound completo COR → Convex cada 10 minutos.
crons.interval(
  "scheduled cor inbound sync",
  { minutes: 10 },
  internal.data.corInboundSync.runScheduledInboundSyncAction,
  {}
);

export default crons;
