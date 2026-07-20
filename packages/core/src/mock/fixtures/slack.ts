/**
 * Slack Events API fixtures. Each key is an inner event type
 * (e.g. `app_mention`, `message`) wrapped in the `event_callback` envelope.
 */
export const slackFixtures: Record<string, unknown> = {
  app_mention: {
    type: "event_callback",
    token: "verification_token",
    team_id: "T0123456",
    api_app_id: "A0123456",
    event: {
      type: "app_mention",
      user: "U0123456",
      text: "<@U0LAN0Z89> hello bot",
      ts: "1700000000.000200",
      channel: "C0123456",
      event_ts: "1700000000.000200",
    },
    event_id: "Ev0123456",
    event_time: 1700000000,
    authorizations: [
      {
        enterprise_id: null,
        team_id: "T0123456",
        user_id: "U0LAN0Z89",
        is_bot: true,
      },
    ],
  },

  message: {
    type: "event_callback",
    token: "verification_token",
    team_id: "T0123456",
    api_app_id: "A0123456",
    event: {
      type: "message",
      user: "U0123456",
      text: "Hello, world!",
      ts: "1700000000.000300",
      channel: "C0123456",
      event_ts: "1700000000.000300",
      channel_type: "channel",
    },
    event_id: "Ev0123457",
    event_time: 1700000000,
  },
};
