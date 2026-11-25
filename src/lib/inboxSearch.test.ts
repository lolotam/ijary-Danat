import { describe, expect, test } from "vitest";

import { parseInboxSearch } from "./inboxSearch";

describe("parseInboxSearch — ?chat= deep link", () => {
  test("normalises a bare local mobile into the stored chat number", () => {
    expect(parseInboxSearch({ tab: "whatsapp", chat: "50000000" })).toEqual({
      tab: "whatsapp",
      chat: "96550000000",
    });
  });

  test("accepts an international number with or without + and spaces", () => {
    // All three spellings of one tenant's number must open one thread.
    const shapes = ["+96550000000", "96550000000", "+965 5000 0000"];
    const chats = shapes.map((chat) => parseInboxSearch({ chat }).chat);
    expect(chats).toEqual(["96550000000", "96550000000", "96550000000"]);
  });

  test("drops a quoted value's quotes, the way a pasted link carries them", () => {
    expect(parseInboxSearch({ tab: '"whatsapp"', chat: '"96550000000"' })).toEqual({
      tab: "whatsapp",
      chat: "96550000000",
    });
  });

  test("drops an unusable chat value instead of opening a thread", () => {
    // A landline, a fragment, an empty param and a non-string all mean "no
    // deep link" — the inbox must land on its normal tab, not on a thread
    // nobody can send from.
    for (const chat of ["22334455", "12345", "", "   ", null, 5]) {
      expect(parseInboxSearch({ chat }).chat).toBeUndefined();
    }
  });

  test("returns nothing at all for an empty query string", () => {
    expect(parseInboxSearch({})).toEqual({});
  });
});

describe("parseInboxSearch — the other params", () => {
  test("keeps a known tab and folder, drops unknown ones", () => {
    expect(parseInboxSearch({ tab: "gmail", folder: "sent" })).toEqual({
      tab: "gmail",
      folder: "sent",
    });
    expect(parseInboxSearch({ tab: "nope", folder: "archive" })).toEqual({});
  });

  test("carries the highlighted message id through", () => {
    expect(parseInboxSearch({ message: "abc", tab: "tenants" })).toEqual({
      message: "abc",
      tab: "tenants",
    });
  });
});
