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

// Medianoche de Ecuador continental (UTC-5) equivale a 05:00 UTC.
crons.daily(
  "scheduled expired cor inbound sync",
  { hourUTC: 5, minuteUTC: 0 },
  internal.data.corInboundSync.runScheduledExpiredInboundSyncAction,
  {}
);

export default crons;
