import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * يثبت ترويسة خيط المحادثة: شريط ملوّن باسم بارز أوسطه، الرقم في أول
 * السطر والمستأجر المرتبط في آخره وكلاهما يفتح صفحة المستأجر، زر إضافة
 * للرقم الجديد وزر تعديل للمخزّن في الموضع نفسه، وصورة الحساب قبل الاسم،
 * ورجوع الصورة البديلة للمحاولة عند وصول رابط جديد.
 *
 * Mirrors the inbox requirement that a stored number is one tap from its
 * contact form, that a thread is one tap from the tenant it is about, and
 * that an expired WhatsApp CDN picture does not stick on initials after
 * "Sync history" refreshes the URL.
 */
const header = readFileSync(
  resolve(process.cwd(), "src/components/admin/whatsapp/WhatsAppThreadHeader.tsx"),
  "utf8",
);
const inboxTab = readFileSync(
  resolve(process.cwd(), "src/components/admin/whatsapp/WhatsAppInboxTab.tsx"),
  "utf8",
);
const chatList = readFileSync(
  resolve(process.cwd(), "src/components/admin/whatsapp/WhatsAppChatList.tsx"),
  "utf8",
);

describe("whatsapp thread header", () => {
  test("شريط ملوّن واسم بارز على خلفية ملوّنة", () => {
    expect(header).toMatch(/bg-primary\/10/);
    expect(header).toMatch(/bg-primary\/85[^"]*font-bold/);
  });

  test("الرقم واسم المستأجر يفتحان صفحة المستأجر", () => {
    // Both halves of the identity line link to the same record; the tenant id
    // is what routes, so a contact with no tenant must not render a link.
    expect([...header.matchAll(/to="\/admin\/tenants\/\$id"/g)]).toHaveLength(2);
    expect(header).toMatch(/params=\{\{ id: tenant\.id \}\}/);
    expect(header).toMatch(/justify-between/);
  });

  test("إضافة للجديد وتعديل للمخزّن في الموضع نفسه", () => {
    expect(header).toMatch(/needsContact \? <UserPlus/);
    expect(header).toMatch(/<Pencil/);
    expect(inboxTab).toMatch(/splitContactName\(selectedContact/);
  });

  test("صورة الحساب تظهر قبل الاسم في الترويسة", () => {
    expect(header).toMatch(/<ChatAvatar/);
    expect(header).toMatch(/avatarUrl=\{chat\?\.avatar_url/);
  });

  test("رابط صورة جديد يعيد المحاولة بعد فشل سابق", () => {
    expect(chatList).toMatch(/setFailed\(false\)/);
    expect(chatList).toMatch(/\[avatarUrl\]/);
  });
});
