import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EmailDelivery, Job, StudentProfile } from "@gradlaunch/shared";
import { getEmailOutboxStorageDir } from "../config/storage";
import { createId } from "../lib/id";
import { nowIso } from "../lib/time";

type ApplicationNotificationInput = {
  student: StudentProfile;
  job: Job;
  workspacePath?: string;
  externalSubmitted: boolean;
};

type NodemailerModule = {
  createTransport(config: Record<string, unknown>): {
    sendMail(input: {
      from: string;
      to: string;
      subject: string;
      text: string;
      html: string;
    }): Promise<unknown>;
  };
};

export class EmailService {
  async sendApplicationCompletion(input: ApplicationNotificationInput): Promise<EmailDelivery> {
    const subject = input.externalSubmitted
      ? `GradLaunch submitted ${input.job.company} - ${input.job.title}`
      : `GradLaunch review package ready: ${input.job.company} - ${input.job.title}`;
    const body = buildApplicationEmailBody(input);
    const sentAt = nowIso();

    if (hasSmtpConfig()) {
      try {
        const nodemailer = await loadNodemailer();
        const transport = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT ?? 587),
          secure: process.env.SMTP_SECURE === "true",
          auth: process.env.SMTP_USER && process.env.SMTP_PASS
            ? {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
              }
            : undefined
        });

        await transport.sendMail({
          from: process.env.MAIL_FROM ?? "GradLaunch <no-reply@gradlaunch.local>",
          to: input.student.email,
          subject,
          text: body.text,
          html: body.html
        });

        return {
          status: "sent",
          provider: "nodemailer",
          to: input.student.email,
          subject,
          sentAt,
          message: "Confirmation email sent through Nodemailer."
        };
      } catch (error) {
        return {
          status: "failed",
          provider: "nodemailer",
          to: input.student.email,
          subject,
          sentAt,
          message: error instanceof Error ? error.message : "Nodemailer failed to send the confirmation email."
        };
      }
    }

    const outboxPath = await saveOutboxEmail({
      to: input.student.email,
      subject,
      text: body.text,
      html: body.html,
      sentAt
    });

    return {
      status: "queued",
      provider: "outbox",
      to: input.student.email,
      subject,
      sentAt,
      message: `SMTP is not configured yet. Email receipt saved to ${outboxPath}.`
    };
  }
}

async function loadNodemailer(): Promise<NodemailerModule> {
  // Nodemailer is loaded at runtime so local development still works before SMTP is configured.
  const module = await import("nodemailer");
  return module.default ?? module;
}

function hasSmtpConfig() {
  return Boolean(process.env.SMTP_HOST);
}

function buildApplicationEmailBody(input: ApplicationNotificationInput) {
  const resultLine = input.externalSubmitted
    ? "Your application was submitted through the connected apply worker."
    : "Your complete review package was saved and is ready for final portal submission.";
  const workspaceLine = input.workspacePath
    ? `Workspace: ${input.workspacePath}`
    : "Workspace: not recorded for this run";
  const text = [
    `Hi ${input.student.fullName},`,
    "",
    resultLine,
    "",
    `Role: ${input.job.title}`,
    `Company: ${input.job.company}`,
    workspaceLine,
    "",
    "GradLaunch"
  ].join("\n");

  return {
    text,
    html: text
      .split("\n")
      .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<br />"))
      .join("")
  };
}

async function saveOutboxEmail(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
  sentAt: string;
}) {
  const outboxDir = getEmailOutboxStorageDir();
  await mkdir(outboxDir, { recursive: true });

  const path = join(outboxDir, `${createId("email")}.json`);
  await writeFile(path, `${JSON.stringify(input, null, 2)}\n`, "utf-8");
  return path;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
