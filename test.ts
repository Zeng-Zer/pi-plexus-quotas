import assert from "node:assert/strict";
import { lineFromPayload } from "./index.ts";

const now = Date.parse("2026-08-15T18:02:13.000Z");
const line = lineFromPayload(
  [
    {
      checkerId: "upstream",
      checkerType: "neuralwatt",
      provider: "upstream",
      success: true,
      meters: [{ key: "credit_balance", used: 11.0044, limit: 20, unit: "usd" }],
    },
    {
      checkerId: "openai",
      checkerType: "openai-codex",
      provider: "openai",
      success: true,
      meters: [
        {
          key: "primary",
          used: 33,
          unit: "percentage",
          resetsAt: "2026-08-20T03:31:49.000Z",
        },
      ],
    },
    {
      checkerId: "cursor",
      checkerType: "cursor",
      provider: "cursor",
      success: true,
      meters: [
        {
          key: "included_spend",
          used: 0.17,
          limit: 20,
          unit: "usd",
          resetsAt: "2026-09-11T15:34:46.000Z",
        },
      ],
    },
  ],
  now,
);

assert.equal(
  line,
  "neuralwatt: $11/$20 | openai: 33% · (4d 9h) | cursor: $0.17/$20 · (26d)",
);

assert.equal(
  lineFromPayload([
    {
      checkerId: "openai",
      provider: "openai",
      meters: [
        { key: "primary", used: 12, unit: "percentage", periodValue: 5, periodUnit: "hour" },
        { key: "secondary", used: 33, unit: "percentage", periodValue: 7, periodUnit: "day" },
      ],
    },
  ]),
  "openai: 5h 12% / 7d 33%",
);

assert.equal(
  lineFromPayload(
    [
      {
        checkerId: "cursor",
        provider: "cursor",
        meters: [
          {
            key: "cursor_models",
            used: 0.0567,
            limit: 100,
            unit: "percentage",
            resetsAt: "2026-09-11T15:34:46.000Z",
          },
          {
            key: "other_models",
            used: 0.0444,
            limit: 100,
            unit: "percentage",
            resetsAt: "2026-09-11T15:34:46.000Z",
          },
        ],
      },
    ],
    now,
  ),
  "cursor: models 0.1% / other 0.1% · (26d)",
);
