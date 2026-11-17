import nodemailer from "nodemailer";

export type Mail = { to: string; subject: string; text: string };

export type Mailer = (mail: Mail) => Promise<void>;

// How the app sends mail: through the SMTP server in SMTP_URL, or, with
// none configured outside production, by printing the message to the server
// log so the link can be copied from there. A production build without
// SMTP_URL fails loudly rather than silently losing every verification link.
export function createMailer(env: Record<string, string | undefined> = process.env): Mailer {
  const from = env.MAIL_FROM ?? "Clementine <abacus@localhost>";
  if (env.SMTP_URL) {
    const transport = nodemailer.createTransport(env.SMTP_URL);
    return async (mail) => {
      await transport.sendMail({ from, ...mail });
    };
  }
  if (env.NODE_ENV === "production") {
    throw new Error("SMTP_URL is not set; sign-in emails cannot be sent");
  }
  return async (mail) => {
    console.log(`\n[mail] to: ${mail.to}\n[mail] subject: ${mail.subject}\n${mail.text}\n`);
  };
}
