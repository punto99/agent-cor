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

// Cada 6 horas desde medianoche de Ecuador continental (UTC-5).
crons.cron(
  "scheduled expired cor inbound sync",
  "0 5,11,17,23 * * *",
  internal.data.corInboundSync.runScheduledExpiredInboundSyncAction,
  {}
);

export default crons;
