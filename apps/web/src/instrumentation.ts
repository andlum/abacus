// Runs once when a server starts. Starts the daily job (src/lib/daily-job.ts)
// in the Node server only; it decides itself whether it is wanted here.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startDailyJob } = await import("@/lib/daily-job");
  await startDailyJob();
}
