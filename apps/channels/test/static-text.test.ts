import { describe, expect, it } from "vitest";
import { extractLinks } from "@mano/channels";
import {
  APPROVAL_RECORDED_BUBBLE,
  BUSY_BUBBLE,
  FAILURE_BUBBLE,
  INTERIM_BUBBLE,
  INTRO_BUBBLE,
  OPT_OUT_BUBBLE,
  attachmentAck,
} from "../src/text.js";

describe("static reply texts", () => {
  it("carry no links, so the send path needs no second sanitize", () => {
    const texts = [
      INTRO_BUBBLE,
      INTERIM_BUBBLE,
      FAILURE_BUBBLE,
      BUSY_BUBBLE,
      OPT_OUT_BUBBLE,
      APPROVAL_RECORDED_BUBBLE,
      attachmentAck(1),
      attachmentAck(5),
    ];
    for (const text of texts) {
      expect(extractLinks(text)).toEqual([]);
    }
  });
});
