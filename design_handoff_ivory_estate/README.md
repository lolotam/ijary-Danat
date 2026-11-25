# Danat Al Mustaqbal Design System

**دانة المستقبل العقارية — Danat Al Mustaqbal Real Estate Co (Kuwait)**

Source of truth: https://github.com/lolotam/Dana-kuwait — a bilingual (Arabic-first, RTL/LTR) real-estate management platform built with Lovable, TanStack Start, Tailwind v4, shadcn/ui (new-york style), Radix primitives, and Lucide icons. Explore that repo for deeper context (routes in `src/routes/`, shadcn components in `src/components/ui/`, full AR/EN copy in `src/i18n/dictionary.ts`, brand tokens in `src/styles.css`).

## Products / surfaces

1. **Marketing landing page** (`/`) — hero over full-bleed photo with gradient protection, features, contact form, footer.
2. **Admin dashboard** (`/admin/*`) — property-management back office: dashboard, monthly invoices, tenants, properties & buildings, units, contracts, payments, bank deposits, expenses, electricity, reports, audit log, settings. Collapsible icon sidebar (right side in RTL).
3. **Tenant portal** (`/portal/*`) — my dashboard, my lease, my invoices, my payments, my receipts, profile. Horizontal pill nav under sticky header.
4. **Auth** (`/auth`) — centered card sign-in (accounts issued by administration only).

Currency is KWD (Kuwaiti Dinar, 3 decimals). Payments via MyFatoorah gateway.

## CONTENT FUNDAMENTALS

- **Arabic is the default locale**; every string exists in AR and EN (`dictionary.ts`). Designs should be RTL-first with an EN mirror.
- Tone: professional, plain, reassuring — no hype, no exclamation except success toasts ("تم إرسال رسالتك بنجاح!").
- Direct second-person imperative for actions: "أدخل اسم المستخدم…" / "Enter the username…"; "املأ النموذج وسنعاود التواصل معك" / "Fill in the form and we'll get back to you shortly."
- Feature copy is benefit-led and factual: "إدارة عقارية احترافية، بكل بساطة" / "Professional real-estate operations, made simple"; tagline "منصة متكاملة لإدارة العقارات، العقود، والمدفوعات".
- Labels are short nouns: "الفواتير", "المستأجرون", "العقود"; portal nav uses possessive first person: "لوحتي، عقدي، فواتيري، مدفوعاتي، إيصالاتي".
- **No emoji anywhere.** Ellipsis "…" used for loading ("جارٍ التحميل…"). EN casing: sentence case for body/buttons, Title Case for nav/modules ("Bank Deposits", "Properties & Buildings").
- Errors are calm and instructive: "تعذّر تحميل البيانات. حاول مرة أخرى." / "Invalid credentials."

## VISUAL FOUNDATIONS

- **Colors (v2 — "Ivory Estate", chosen July 2026)**: warm ivory page `#F7F3EA`, near-black ink `#171512` for text & primary actions, brand gold `#D4AF37` (deep gold `#9C7A1E` for text on light), parchment borders `#E7DFC9`, pure-white cards. Brand-black `--ink #0E0D0B` bands for headers/hero/footers where the gold lotus logo lives. `.dark` scope = full ink theme with gold primary. This replaces the repo's teal placeholder palette (it was explicitly awaiting the official logo).
- **Type**: IBM Plex Sans Arabic everywhere (one family, weights 400–700). Headlines bold (`font-bold`), UI labels medium/semibold, sizes from 11px meta up to 6xl hero. No serif, no mono in product UI.
- **Radii**: base `--radius: 0.875rem`. **All buttons are pills** (9999px). Cards 14px, imagery 18px, inputs 12px, tabs list `rounded-lg`.
- **Cards**: white bg, 1px `--border`, `shadow` (soft, small). Stat cards: `rounded-xl border bg-card p-5/6`.
- **Shadows**: restrained Tailwind defaults — `shadow-sm` on inputs/outline buttons, `shadow` on primary buttons/cards, `shadow-lg` only on dialogs. No colored or inner shadows.
- **Spacing**: 4px grid; page padding p-6 (admin main), sections py-24; card padding p-5/p-6; control height h-9 (36px) standard, h-8 sm, h-10 lg.
- **Backgrounds**: flat token colors. Landing hero = full-bleed photo + `bg-gradient-to-b from-background/85 via-background/70 to-background` protection gradient. Sticky headers use `bg-background/80–95 backdrop-blur`. Admin/portal body `bg-background` / `bg-muted/30`. No patterns, no illustrations.
- **Hover states**: opacity-shift on solid fills (`hover:bg-primary/90`), tint fill on ghost/outline (`hover:bg-accent` or `hover:bg-muted`), text color shift on links (`hover:text-primary`). Press: no scale effects. Focus: 1px ring `--ring` (`focus-visible:ring-1`).
- **Animation**: subtle only — `transition-colors`/`transition-all` on controls; Radix `animate-in/out` fade+zoom-95 for dialogs/selects; `animate-pulse` skeletons. No bounces, no parallax.
- **Transparency/blur**: only sticky headers (backdrop-blur) and overlay `bg-black/80`.
- **Imagery**: photographic, cool modern architecture (see `assets/landing/`). No hand-drawn or 3D illustration.
- **RTL**: `dir` flips the whole layout; sidebar moves to the right; use logical properties/`gap`, mirror chevrons with `.flip-x`.

## ICONOGRAPHY

- **Lucide** is the only icon system (`iconLibrary: "lucide"`), 16–24px, default 2px stroke, `currentColor`. Loaded here via the lucide UMD CDN + the `Icon` component (`components/display/Icon.jsx`) — a substitution for the npm `lucide-react` package; same glyphs.
- Common glyphs: layout-dashboard, file-text, users, building-2, home, scroll-text, credit-card, banknote, receipt, bar-chart-3, shield-check, settings, zap, mail, facebook, instagram, check, chevron-down, x, search, plus.
- No icon font, no emoji, no unicode-as-icon. Feature icons sit in a 40px `bg-primary/10 text-primary rounded-md` tile.
- **Logo: official mark provided** (`assets/logo.png`) — a gold calligraphic "D" with a lotus fan inside a gold ring, on a black rounded square. Use it via the `Logo` component (default). The in-product UI historically used a "د" monogram on a `--primary` tile; that remains available as `<Logo variant="monogram"/>`. `assets/favicon.ico` is the app favicon. Note: the logo is gold-on-black while the UI tokens are teal+gold; the repo calls the palette "placeholder … refined once the official logo is provided" — confirm with the brand owner before rebranding tokens.

## Index

- `styles.css` → `tokens/colors.css`, `tokens/typography.css`, `tokens/shape.css`
- `assets/` — logo.png (official mark), favicon, `landing/hero.png`, `landing/feature.png`
- `components/forms/` — Button, Input, Textarea, Label, Checkbox, RadioGroup, Switch, Select
- `components/display/` — Card, Badge, Avatar, Table, Alert, Skeleton, Separator, Progress, Icon, Logo
- `components/navigation/` — Tabs, Breadcrumb, SidebarNav, PortalNav
- `components/overlay/` — Dialog, Tooltip
- `ui_kits/landing/` — marketing landing page recreation
- `ui_kits/admin/` — admin dashboard (sidebar + invoices table + dialog)
- `ui_kits/portal/` — tenant portal dashboard
- `ui_kits/auth/` — sign-in screen
- `guidelines/` — foundation specimen cards

## Intentional additions

- `Icon` — wrapper over lucide UMD (repo uses `lucide-react`, not usable without a bundler).
- `Logo` — official logo tile (assets/logo.png) with "د" monogram variant for the in-product tile.
- `SidebarNav`/`PortalNav` — cosmetic recreations of the repo's shadcn Sidebar and portal pill nav.

## Not (yet) built from the repo's 46 shadcn files

accordion, alert-dialog, aspect-ratio, calendar, carousel, chart, collapsible, command, context-menu, drawer, dropdown-menu, form, hover-card, input-otp, menubar, navigation-menu, pagination, popover, resizable, scroll-area, sheet, sidebar (full behavior), slider, sonner, toggle, toggle-group — these are stock shadcn new-york with no local overrides; ask to extend coverage if needed.
