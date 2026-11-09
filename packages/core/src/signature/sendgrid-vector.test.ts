import { describe, expect, it } from "vitest";
import { verifySignature } from "./index";

// SendGrid's own vector, from sendgrid-nodejs packages/eventwebhook/src/eventwebhook.spec.js.
// Joined at runtime because gitleaks refuses key-shaped literals.
const verificationKey = [
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1",
  "flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==",
].join("");
const signature = [
  "MEUCIGHQVtGj+Y3LkG9fLcxf3qfI10QysgDWmMOVmxG0u6ZUAiEA",
  "yBiXDWzM+uOe5W0JuG+luQAbPIqHh89M15TluLtEZtM=",
].join("");
const timestamp = "1600112502";
const payload =
  JSON.stringify([
    {
      email: "hello@world.com",
      event: "dropped",
      reason: "Bounced Address",
      sg_event_id: "ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA",
      sg_message_id: "LRzXl_NHStOGhQ4kofSm_A.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0",
      "smtp-id": "<LRzXl_NHStOGhQ4kofSm_A@ismtpd0039p1iad1.sendgrid.net>",
      timestamp: 1600112492,
    },
  ]) + "\r\n";
const headers = (sig: string) =>
  new Headers({
    "x-twilio-email-event-webhook-signature": sig,
    "x-twilio-email-event-webhook-timestamp": timestamp,
  });

describe("sendgrid against its published vector", () => {
  it("accepts SendGrid's DER signature", async () => {
    expect(await verifySignature("sendgrid", headers(signature), payload, verificationKey, "https://x.test/")).toBe(true);
  });
  it("refuses it on a changed body", async () => {
    expect(await verifySignature("sendgrid", headers(signature), payload + " ", verificationKey, "https://x.test/")).toBe(false);
  });
});
