import { describe, expect, it, vi } from "vitest";
import { createMailer } from "./mail";

describe("createMailer", () => {
  it("prints the message to the log when there is no SMTP_URL outside production", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const send = createMailer({ NODE_ENV: "development" });
    await send({ to: "alex@example.com", subject: "Verify", text: "https://example.com/verify?token=abc" });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toContain("https://example.com/verify?token=abc");
    log.mockRestore();
  });

  it("refuses to start in production without SMTP_URL", () => {
    expect(() => createMailer({ NODE_ENV: "production" })).toThrow(/SMTP_URL/);
  });
});
