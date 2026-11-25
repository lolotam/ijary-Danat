# Danat Al Jahra Landing Page Restructure — Product Requirements Document

**Project:** Danat Al Mustaqbal ERMP  
**Public destination:** Danat Al Jahra Commercial Complex  
**Document type:** Product Requirements Document (PRD)  
**Status:** Ready for implementation planning  
**Primary languages:** Arabic (RTL) and English (LTR)  
**Existing stack:** TanStack Start, React 19, Tailwind CSS 4, shadcn/ui, Supabase, custom i18n  
**Asset ownership:** The website administrator will upload the final logo, brand logos, property images, gallery images, map links, written content, and contact details.

---

## 1. Executive Summary

The current application already contains a public landing page, but it needs to be restructured into a premium, modern, interactive destination website for **Danat Al Jahra**, a commercial complex managed by **Danat Al Mustaqbal Real Estate**.

The new landing page must:

- Present Danat Al Jahra as an attractive commercial and lifestyle destination.
- Showcase the shops, brands, restaurants, services, and facilities available in the complex.
- Help visitors understand the location and reach the complex easily.
- Provide a premium, highly visual experience using the real property photography.
- Support Arabic RTL and English LTR completely.
- Allow the administrator to upload and replace all content and visual assets without code changes.
- Preserve access to the existing staff and tenant login flows.
- Remain fast, accessible, responsive, and SEO-friendly despite the rich visual interactions.

The landing page is not an e-commerce website and should not look like a conventional real estate listing page. It should feel like a **digital destination experience** for a modern Kuwaiti commercial complex.

---

## 2. Product Vision

### Arabic positioning

> دانة الجهراء — وجهتك اليومية للتسوق والخدمات في قلب الجهراء

### English positioning

> Danat Al Jahra — Your Everyday Destination in the Heart of Jahra

### Experience principles

1. **The place comes first:** visitors should immediately understand what Danat Al Jahra is.
2. **The tenants are the attraction:** shops and brands must be easy to discover.
3. **Real photography over stock photography:** the site should use the actual complex and uploaded tenant assets.
4. **Premium but approachable:** luxurious enough to elevate the brand, while still feeling useful and welcoming.
5. **Movement with purpose:** animations should guide attention, not distract from content.
6. **Admin-managed content:** all major sections must be editable from structured data or admin settings.
7. **Bilingual by design:** Arabic and English must both feel native rather than translated afterthoughts.

---

## 3. Business Goals

### Primary goals

- Increase awareness of Danat Al Jahra as a commercial destination.
- Encourage physical visits to the complex.
- Increase discovery of existing tenants and brands.
- Improve Google Maps direction clicks.
- Improve commercial leasing enquiries.
- Strengthen the public identity of Danat Al Mustaqbal.
- Provide a professional public-facing website connected to the existing management platform.

### Secondary goals

- Support promotional campaigns and seasonal events.
- Provide a central location for opening hours and visitor information.
- Improve social media sharing.
- Allow future expansion to additional complexes managed by the same company.

---

## 4. Target Audiences

### 4.1 Visitors and families

People in Jahra and surrounding areas looking for:

- Restaurants and cafés
- Shopping
- Beauty and wellness
- Fitness
- Medical and pharmacy services
- Family services
- Daily commercial services
- Easy parking and accessible location

### 4.2 Existing tenants

Current shops and businesses that benefit from:

- Increased visibility
- A professional brand directory
- Direct contact or location information
- Promotion through official complex channels

### 4.3 Prospective tenants

Businesses looking to lease a shop or commercial unit.

### 4.4 Property management staff

Internal staff responsible for updating:

- Hero banners
- Gallery images
- Store logos
- Store information
- Opening hours
- Contact details
- Leasing CTA
- Map details
- Announcement banners

---

## 5. Existing Product Context

The landing page already exists as part of the Danat Al Mustaqbal ERMP. The restructure must work inside the current application rather than creating a separate disconnected website.

Implementation must preserve:

- TanStack Start routing
- React 19
- Tailwind CSS 4
- Existing shadcn/ui conventions
- Existing Arabic/English i18n
- Existing authentication routes
- Existing tenant portal
- Existing admin dashboard
- Existing Supabase deployment
- Existing Dokploy deployment workflow

The implementation must not use Next.js-specific patterns.

---

## 6. Brand Direction and Logo-Derived Palette

The uploaded logo uses a premium black-and-gold identity. The landing page should derive its visual system from that logo rather than introducing an unrelated green or blue corporate palette.

### 6.1 Core color tokens

| Token          | Suggested value | Purpose                   |
| -------------- | --------------: | ------------------------- |
| Obsidian Black |       `#050505` | Primary dark background   |
| Rich Black     |       `#0B0B0B` | Alternate dark surface    |
| Charcoal       |       `#191919` | Cards and overlays        |
| Royal Gold     |       `#F2CD60` | Main brand accent         |
| Warm Gold      |       `#E0A738` | Secondary accent          |
| Deep Gold      |       `#C98A24` | Borders, hover, shadows   |
| Champagne      |       `#F6E3A3` | Light highlight           |
| Ivory          |       `#F8F4EA` | Light section background  |
| Soft Stone     |       `#D6D0C5` | Muted text and separators |
| Pure White     |       `#FFFFFF` | Text and high contrast    |

### 6.2 Gold usage rules

- Gold should be used as a premium accent, not as a large flat background.
- Use gold for:
  - Buttons
  - Active navigation indicators
  - Thin borders
  - Section labels
  - Decorative curves
  - Progress indicators
  - Hover highlights
- Avoid excessive gradients on body text.
- Avoid low-contrast gold text over light backgrounds.
- Use metallic gradients only for decorative or branded elements.

### 6.3 Suggested metallic gradient

```css
linear-gradient(
  135deg,
  #C98A24 0%,
  #F2CD60 35%,
  #F6E3A3 55%,
  #E0A738 78%,
  #B87318 100%
)
```

### 6.4 Visual mood

- Premium
- Architectural
- Black and gold
- Modern Kuwaiti
- Cinematic sunset photography
- High contrast
- Elegant curves inspired by the logo mark
- Minimal glass effects
- Spacious layouts
- Strong typography

---

## 7. Typography

### Arabic

Preferred order:

1. IBM Plex Sans Arabic
2. Alexandria
3. Noto Kufi Arabic

### English

Preferred order:

1. Manrope
2. Plus Jakarta Sans
3. Inter

### Typography rules

- Hero heading: large and high impact.
- Body text: readable and not overly thin.
- Arabic line height must be slightly more generous than English.
- Use responsive `clamp()` sizing.
- Do not use decorative fonts for long content.
- Maintain visually equivalent hierarchy in Arabic and English.

---

## 8. Site Information Architecture

The public page should use the following order:

1. Announcement strip — optional
2. Transparent sticky header
3. Fullscreen hero section
4. Quick visitor information bar
5. About Danat Al Jahra
6. Brand logos carousel
7. Shops and categories explorer
8. Large 16:9 hero image carousel
9. Experience and facilities section
10. Interactive gallery carousel
11. Location and directions
12. Leasing enquiry CTA
13. Contact and social section
14. Footer
15. Floating quick actions

---

# 9. Detailed Section Requirements

## 9.1 Announcement Strip

### Purpose

Display temporary announcements such as:

- New store openings
- Ramadan hours
- National Day events
- Special promotions
- Maintenance notices

### Mockup

```text
┌────────────────────────────────────────────────────────────┐
│ ✦ New opening at Danat Al Jahra — Discover more     [×]   │
└────────────────────────────────────────────────────────────┘
```

### Requirements

- Optional and admin-controlled.
- Arabic and English fields.
- Can link to a section or external URL.
- Dismissible by the visitor.
- Dismissal stored locally.
- Must not appear if disabled or expired.
- Support start date and end date.

---

## 9.2 Header and Navigation

### Desktop mockup

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Danat Logo]  Home  About  Shops  Gallery  Location  Leasing  [AR] [Login] │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Arabic direction

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ [دخول] [EN] التأجير الموقع المعرض المحلات عن المجمع الرئيسية [شعار دانة] │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Requirements

- Transparent over the first hero.
- Changes to dark glass or solid black after scrolling.
- Sticky at the top.
- Logo remains clearly visible.
- Active section indicator.
- Smooth scroll for internal navigation.
- Language toggle must keep the user in the same section when possible.
- Preserve staff and tenant login access.
- Mobile menu must open as a premium full-screen or side-sheet experience.
- Mobile menu must lock page scrolling while open.
- Keyboard accessible.

### Navigation labels

| Arabic       | English  |
| ------------ | -------- |
| الرئيسية     | Home     |
| عن المجمع    | About    |
| المحلات      | Shops    |
| المعرض       | Gallery  |
| الموقع       | Location |
| التأجير      | Leasing  |
| تسجيل الدخول | Login    |

---

## 9.3 Fullscreen Hero Section

### Purpose

Immediately communicate:

- This is Danat Al Jahra.
- It is a large, active commercial destination.
- The visitor can explore shops or get directions.

### Mockup

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Background: uploaded wide property image / short cinematic video]          │
│                                                                              │
│                         دانة الجهراء                                          │
│             وجهتك اليومية للتسوق والخدمات في قلب الجهراء                    │
│                                                                              │
│                 [استكشف المحلات]  [احصل على الاتجاهات]                       │
│                                                                              │
│                         Scroll to discover ↓                                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Requirements

- Full viewport height on desktop.
- Minimum 80vh on mobile.
- Use an uploaded image or optional short muted video.
- Apply dark gradient overlay to protect text readability.
- The user will upload the final hero asset.
- Initial implementation should use a clearly labeled mock asset.
- Do not hardcode production imagery.
- Hero image focal point must be configurable.
- Support separate desktop and mobile hero images.
- Optional video poster image.
- Primary CTA: Shops.
- Secondary CTA: Directions.
- Optional third CTA: Leasing.
- Text must be editable in both languages.
- Use subtle background zoom or parallax.
- No aggressive autoplay carousel in the first hero.
- Respect reduced-motion preferences.

### Suggested default copy

**Arabic title**

> دانة الجهراء

**Arabic subtitle**

> وجهتك اليومية للتسوق والخدمات في قلب الجهراء

**English title**

> Danat Al Jahra

**English subtitle**

> Your everyday destination for shopping, services, and more.

---

## 9.4 Quick Visitor Information Bar

### Mockup

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ +XX Stores │ Jahra, Kuwait │ Ample Parking │ Open Daily XX:XX–XX:XX        │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Requirements

- Three to five information items.
- Content editable by admin.
- Support icons.
- Support optional link per item.
- Responsive horizontal scroll on small screens.
- Do not display false numbers; use placeholders until real data is entered.
- Potential items:
  - Number of stores
  - Number of parking spaces
  - Opening hours
  - Location
  - Family-friendly facilities

---

## 9.5 About Danat Al Jahra

### Purpose

Explain the complex in a concise, premium editorial section.

### Desktop mockup

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Large vertical image]      ABOUT DANAT AL JAHRA                            │
│ [Secondary overlap image]   A modern commercial destination in Jahra        │
│                             [2–3 paragraph description]                      │
│                             [Explore the complex →]                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Requirements

- Asymmetrical layout.
- One large uploaded image and one optional supporting image.
- Admin-editable heading, body, and CTA.
- Optional animated statistics.
- Images reveal on scroll.
- Layout reverses appropriately for RTL.
- Mobile layout stacks cleanly.

---

## 9.6 Brand Logos Carousel

### Purpose

Show the shops and brands currently present in the complex.

### Mockup

```text
Brands at Danat Al Jahra

← [Logo] [Logo] [Logo] [Logo] [Logo] [Logo] [Logo] →
                      [View all shops]
```

### Requirements

- Infinite horizontal loop.
- Drag with mouse.
- Swipe on touch.
- Pause on hover.
- Direction follows locale:
  - Arabic: right-to-left
  - English: left-to-right
- Support original-language brand names.
- Each brand record supports:
  - Logo
  - Arabic name
  - English name
  - Original commercial name
  - Arabic description
  - English description
  - Category
  - Unit number
  - Floor
  - Phone
  - Website
  - Instagram
  - Opening hours
  - Status
  - Display order
  - Featured toggle
- Clicking a logo opens:
  - A quick-view modal, or
  - A dedicated shop detail route in a later phase.
- Broken or missing logos use a branded placeholder.
- Logo containers must preserve aspect ratio.
- Do not recolor third-party logos unless explicitly permitted.
- Admin can hide inactive tenants.

---

## 9.7 Shops and Categories Explorer

### Purpose

Make discovery more useful than a logo strip alone.

### Mockup

```text
Explore Our Shops

[All] [Food & Café] [Beauty] [Health] [Fitness] [Services]

┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ Brand Logo  │ │ Brand Logo  │ │ Brand Logo  │
│ Brand Name  │ │ Brand Name  │ │ Brand Name  │
│ Category    │ │ Category    │ │ Category    │
└─────────────┘ └─────────────┘ └─────────────┘
```

### Requirements

- Category filters.
- Search by shop name.
- Featured-first ordering.
- “Show more” or pagination.
- Cards may include:
  - Logo
  - Store image
  - Name
  - Category
  - Floor/unit
  - Short description
- Optional “Open now” label if opening-hour logic is implemented.
- Empty state for unavailable categories.
- Full RTL support.
- Mobile: two-column or one-column cards depending on screen size.

---

## 9.8 Large 16:9 Hero Image Carousel

### Purpose

Create a cinematic midpoint in the page using a single large image per slide.

### Mockup

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│                         LARGE 16:9 IMAGE                                     │
│                                                                              │
│  01 / 05                     Slide title and short description               │
│                         ━━━━━━━━━━━━━━━                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Requirements

- Exact display ratio: 16:9.
- One primary image visible at a time.
- Three to five slides recommended.
- Images uploaded by admin.
- Separate text for each slide.
- Fade plus subtle scale transition.
- Manual arrows.
- Swipe and drag.
- Progress indicator.
- Autoplay optional and disabled by default.
- Pause on hover when autoplay is enabled.
- Keyboard accessible.
- Lazy-load non-first slides.
- Mobile images may use alternate crops.
- Avoid stretching images.
- Admin-configurable focal point.

---

## 9.9 Experience and Facilities Section

### Purpose

Explain the practical reasons to visit.

### Suggested items

- Shopping and daily services
- Restaurants and cafés
- Beauty and wellness
- Fitness
- Convenient location
- Parking
- Family-friendly environment
- Extended opening hours

### Mockup

```text
WHY VISIT DANAT AL JAHRA?

┌────────────────┐ ┌────────────────┐ ┌────────────────┐
│ Shopping       │ │ Easy Access    │ │ Parking        │
│ Short text     │ │ Short text     │ │ Short text     │
└────────────────┘ └────────────────┘ └────────────────┘
```

### Requirements

- Three to six cards.
- Lucide icons or uploaded custom icons.
- Subtle mouse-follow glow on desktop.
- Small elevation or tilt effect only.
- No excessive 3D rotation.
- Cards must remain readable without animation.
- Admin-editable in both languages.
- Order can be changed by admin.

---

## 9.10 Interactive Gallery Carousel

### Purpose

Show the complex from multiple exterior and interior perspectives.

### Desktop mockup

```text
Our Gallery

┌──────────────────────────────┐ ┌──────────────┐
│                              │ │ Small image  │
│       Main gallery image     │ ├──────────────┤
│                              │ │ Small image  │
└──────────────────────────────┘ └──────────────┘

                  ← Drag to explore →
```

### Requirements

- Support uploaded exterior and interior images.
- Masonry or editorial composition on desktop.
- Swipe carousel on mobile.
- Full-screen lightbox.
- Captions in Arabic and English.
- Image category:
  - Exterior
  - Interior
  - Shops
  - Facilities
  - Events
  - Parking
- Lightbox supports keyboard navigation.
- Optional image download must be disabled by default.
- Use WebP or AVIF derivatives when available.
- Preserve original uploads in storage.
- Add alt text fields for SEO and accessibility.
- Do not publish images containing identifiable individuals unless authorized.

---

## 9.11 Location and Directions

### Purpose

Turn website interest into a physical visit.

### Mockup

```text
┌──────────────────────────────┬───────────────────────────────────────────────┐
│ Visit Danat Al Jahra         │                                               │
│ Address                      │               INTERACTIVE MAP                 │
│ Opening hours                │                                               │
│ Parking details              │                                               │
│ [Google Maps] [Call]         │                                               │
└──────────────────────────────┴───────────────────────────────────────────────┘
```

### Requirements

- Dedicated section, not hidden inside the gallery.
- Admin fields:
  - Arabic address
  - English address
  - Latitude
  - Longitude
  - Google Maps URL
  - Apple Maps URL
  - Main phone
  - WhatsApp
  - Opening hours
  - Parking description
  - Nearby landmark
- Embedded map must be lazy-loaded.
- Show a placeholder until the map enters the viewport.
- Primary CTA: Open in Google Maps.
- Secondary CTA: Call.
- Mobile: sticky “Directions” quick action.
- Map consent or privacy-friendly loading should be considered.

---

## 9.12 Leasing Enquiry CTA

### Purpose

Generate commercial leasing leads.

### Mockup

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Bring Your Brand to Danat Al Jahra                                           │
│ Join a growing commercial destination serving the Jahra community.           │
│                                                                              │
│ [Submit Leasing Enquiry] [WhatsApp Leasing Team]                             │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Requirements

- Strong visual section with black background and gold detail.
- Opens an enquiry form or dedicated dialog.
- Fields:
  - Name
  - Company name
  - Business activity
  - Phone
  - Email
  - Preferred unit size
  - Message
  - Preferred contact method
  - Consent checkbox
- Arabic and English.
- Validation with Zod.
- Spam protection.
- Success state.
- Error state.
- Store submissions in Supabase.
- Optional email/WhatsApp notification to management.
- Audit-safe handling.
- Do not expose service-role credentials.

---

## 9.13 Contact and Social Section

### Requirements

- Phone
- WhatsApp
- Email
- Instagram
- Google Maps
- Optional TikTok or Snapchat
- Opening hours
- Contact buttons must be touch-friendly.
- Social links open safely in a new tab.
- Admin-editable.
- Avoid displaying empty links.

---

## 9.14 Footer

### Mockup

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Danat Logo]     Explore       Visit          Business                      │
│ Description      Shops         Location       Leasing                       │
│                  Gallery       Hours          Contact                       │
│                                                                              │
│ © Danat Al Mustaqbal Real Estate | Privacy | Terms | Login                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Requirements

- Logo.
- Short description.
- Navigation links.
- Contact information.
- Social links.
- Privacy policy.
- Terms.
- Copyright year generated automatically.
- Staff/tenant login link.
- Locale switch.
- Responsive stacking.
- High contrast.

---

## 9.15 Floating Quick Actions

### Desktop

- Optional small vertical rail:
  - Directions
  - WhatsApp
  - Call

### Mobile

- Fixed bottom action bar:
  - Directions
  - Shops
  - Contact

### Requirements

- Must not block content.
- Respect safe-area insets.
- Hide during open modal.
- Track clicks for analytics.

---

# 10. Asset Management Requirements

The administrator will upload all final production assets.

## 10.1 Required asset groups

### Core brand assets

- Main logo
- Light logo
- Dark logo
- Favicon
- Social sharing image

### Hero assets

- Desktop hero image
- Mobile hero image
- Optional hero video
- Video poster

### About section

- Primary editorial image
- Secondary editorial image

### Carousel assets

- 3–5 large 16:9 slides
- Arabic and English title per slide
- Arabic and English description per slide

### Gallery assets

- Exterior
- Interior
- Parking
- Shops
- Events
- Facilities

### Tenant assets

- Brand logo
- Store cover image
- Optional gallery
- Contact links

## 10.2 Mock asset behavior

Until real assets are uploaded:

- Every section must show a designed mock placeholder.
- Placeholder must be clearly marked in admin as “Replace with final asset.”
- Mock placeholders must preserve final aspect ratios.
- Do not use broken image icons.
- Do not make placeholder content look like verified business information.
- Mock content should be seeded through structured data, not hardcoded across components.

## 10.3 Upload rules

- Validate file type.
- Validate file size.
- Compress and generate responsive variants.
- Support PNG, JPG, WebP, and AVIF where practical.
- SVG allowed only for trusted logo uploads.
- Sanitize filenames.
- Store metadata:
  - Width
  - Height
  - MIME type
  - Alt text
  - Caption
  - Focal point
  - Locale
  - Display order
- Allow archive/disable instead of destructive delete where assets are already referenced.

---

# 11. Admin Content Management

The public landing page must not require code edits for routine content updates.

## 11.1 Recommended admin route

```text
/admin/settings/landing-page
```

## 11.2 Suggested tabs

1. General
2. Header and navigation
3. Hero
4. Visitor information
5. About
6. Brands and shops
7. Large carousel
8. Facilities
9. Gallery
10. Location
11. Leasing
12. Contact and social
13. SEO
14. Publish and preview

## 11.3 Admin capabilities

- Edit Arabic and English text.
- Upload and replace assets.
- Reorder cards and slides.
- Enable or disable sections.
- Schedule announcements.
- Preview Arabic and English.
- Preview desktop, tablet, and mobile.
- Save draft.
- Publish changes.
- Restore last published version.
- Display validation errors before publishing.
- Audit changes.
- Show who last edited and when.

---

# 12. Suggested Data Model

## 12.1 `landing_page_settings`

- `id`
- `locale`
- `hero_title`
- `hero_subtitle`
- `hero_primary_cta_label`
- `hero_primary_cta_target`
- `hero_secondary_cta_label`
- `hero_secondary_cta_target`
- `hero_desktop_media_id`
- `hero_mobile_media_id`
- `hero_video_media_id`
- `about_title`
- `about_body`
- `about_primary_media_id`
- `about_secondary_media_id`
- `leasing_title`
- `leasing_body`
- `is_published`
- `published_at`
- `updated_by`
- timestamps

## 12.2 `landing_page_sections`

- `id`
- `section_key`
- `enabled`
- `display_order`
- `theme`
- `settings_json`
- timestamps

## 12.3 `landing_media`

- `id`
- `storage_path`
- `mime_type`
- `width`
- `height`
- `alt_ar`
- `alt_en`
- `caption_ar`
- `caption_en`
- `focal_x`
- `focal_y`
- `category`
- `is_active`
- `display_order`
- timestamps

## 12.4 `commercial_brands`

- `id`
- `property_id`
- `unit_id`
- `name_original`
- `name_ar`
- `name_en`
- `slug`
- `description_ar`
- `description_en`
- `category_id`
- `logo_media_id`
- `cover_media_id`
- `phone`
- `website_url`
- `instagram_url`
- `opening_hours_json`
- `is_featured`
- `is_active`
- `display_order`
- timestamps

## 12.5 `landing_carousel_slides`

- `id`
- `carousel_key`
- `media_id`
- `mobile_media_id`
- `title_ar`
- `title_en`
- `description_ar`
- `description_en`
- `cta_label_ar`
- `cta_label_en`
- `cta_url`
- `display_order`
- `is_active`
- timestamps

## 12.6 `leasing_inquiries`

- `id`
- `name`
- `company_name`
- `business_activity`
- `phone`
- `email`
- `preferred_size`
- `preferred_contact_method`
- `message`
- `locale`
- `status`
- `source`
- timestamps

---

# 13. Interaction and Motion Specification

## 13.1 Allowed interactions

- Smooth anchor scrolling.
- Header transition after scroll.
- Subtle hero parallax.
- Text reveal.
- Image mask reveal.
- Horizontal drag carousel.
- Button magnetic movement on desktop.
- Small card tilt.
- Cursor-follow glow in selected sections.
- Progress bar animations.
- Lightbox transitions.
- Section fade and translate.

## 13.2 Motion limits

- Do not animate every element.
- Avoid long page-entry sequences.
- No animation should block interaction.
- Hover effects must not be required to access information.
- Avoid scroll hijacking.
- Avoid exaggerated 3D transforms.
- Avoid autoplay audio.
- Reduce or remove effects on low-power/mobile devices.

## 13.3 Reduced-motion behavior

When `prefers-reduced-motion: reduce` is enabled:

- Disable parallax.
- Disable continuous logo animation.
- Disable scale transitions.
- Use instant or short fades.
- Keep all content accessible.

---

# 14. Responsive Requirements

## Desktop

- Wide editorial layout.
- Full-width visual sections.
- Multi-column cards.
- Mouse interactions enabled.

## Tablet

- Simplified two-column layouts.
- Reduced animation intensity.
- Carousels remain swipeable.

## Mobile

- Single-column content.
- Fixed bottom quick actions.
- No custom cursor.
- No heavy parallax.
- Touch targets at least 44×44 px.
- Images use mobile-specific focal points.
- Header uses compact logo and menu.
- Forms use mobile-friendly input types.

### Target widths

- 320 px minimum
- 375 px
- 430 px
- 768 px
- 1024 px
- 1280 px
- 1440 px
- 1920 px

---

# 15. Accessibility Requirements

Target: WCAG 2.2 AA where practical.

- Proper semantic landmarks.
- Heading hierarchy.
- Keyboard navigation.
- Visible focus states.
- Accessible carousel controls.
- Pause control for autoplay.
- Meaningful alt text.
- Decorative images use empty alt text.
- High contrast.
- Form labels and validation messages.
- Error summaries.
- Language and direction attributes update correctly.
- Lightbox focus trap.
- Escape closes dialogs.
- No essential information conveyed by color only.
- Avoid flashing effects.

---

# 16. Performance Requirements

### Targets

- LCP under 2.5 seconds on a reasonable mobile connection.
- CLS under 0.1.
- INP under 200 ms where practical.
- Initial JavaScript should remain controlled.
- Hero image should be optimized and preloaded.
- Non-critical images lazy-loaded.

### Required techniques

- Responsive `srcset`.
- AVIF/WebP derivatives.
- Correct width and height attributes.
- Lazy loading.
- Route/component splitting.
- Defer map loading.
- Avoid shipping all gallery images in the initial bundle.
- Avoid large animation libraries unless justified.
- Pause offscreen carousels.
- Cache public landing data.
- Use skeletons sparingly.

---

# 17. SEO Requirements

## Metadata

- Arabic and English title.
- Arabic and English description.
- Canonical URL.
- Open Graph image.
- Twitter card.
- Correct locale alternates.
- Structured heading hierarchy.

## Structured data

Consider:

- `Organization`
- `LocalBusiness`
- `ShoppingCenter`
- `PostalAddress`
- `OpeningHoursSpecification`
- `GeoCoordinates`

## Content requirements

- Indexable text for the complex.
- Address and phone in crawlable HTML.
- Alt text for property images.
- Descriptive brand names.
- Avoid text embedded only inside images.
- Generate sitemap and robots rules compatible with the existing app.

---

# 18. Analytics and Events

Recommended tracked events:

- `hero_shops_click`
- `hero_directions_click`
- `header_login_click`
- `brand_logo_click`
- `shop_filter_select`
- `shop_search`
- `carousel_slide_view`
- `gallery_open`
- `gallery_next`
- `directions_click`
- `phone_click`
- `whatsapp_click`
- `leasing_form_open`
- `leasing_form_submit`
- `language_switch`
- `footer_social_click`

Analytics must not expose private tenant or authenticated user data.

---

# 19. Security and Privacy

- Public content is read-only.
- Admin content changes require appropriate permission.
- Use RLS for content-management tables.
- Validate all URLs.
- Sanitize rich text.
- Restrict SVG uploads.
- Validate MIME type server-side.
- Rate-limit enquiry submissions.
- Add bot protection.
- Do not expose service-role keys.
- Do not log sensitive form details unnecessarily.
- Add privacy consent where required.
- Preserve audit logs for published changes.

---

# 20. Error, Empty, and Loading States

## Hero asset missing

Show branded black background with logo and text.

## No brands available

Show:

> Shop directory is being updated.

## Gallery empty

Hide the gallery section or show a controlled branded placeholder.

## Map unavailable

Show the address and a direct Google Maps button.

## Form failure

Keep entered data and show a clear retry message.

## Content API failure

Use the last published cached version.

---

# 21. Implementation Phases

## Phase 0 — Discovery and audit

**Priority: P0**

### Tasks

- Audit current `src/routes/index.tsx`.
- Audit current landing components.
- Audit current i18n keys.
- Audit current property media tables.
- Audit current Supabase storage buckets.
- Identify reusable components.
- Identify current landing data dependencies.
- Confirm existing login links.
- Confirm production SEO behavior.

### Acceptance criteria

- Written audit completed.
- No current feature is accidentally removed.
- Final technical plan maps old sections to new sections.

---

## Phase 1 — Foundation and brand system

**Priority: P0**

### Tasks

- Add logo-derived design tokens.
- Add dark/light surface system.
- Add typography tokens.
- Add container and spacing system.
- Add reusable section header.
- Add reusable bilingual content model.
- Add mock media placeholder component.
- Add reduced-motion utilities.

### Testing

- Arabic RTL visual test.
- English LTR visual test.
- Contrast test.
- Mobile token test.
- Dark background logo visibility test.

---

## Phase 2 — Data and admin foundation

**Priority: P0**

### Tasks

- Add landing page tables.
- Add idempotent SQL migration.
- Add RLS policies.
- Add storage bucket/policies.
- Extend generated or local database types.
- Add landing-page admin route.
- Add section enable/disable.
- Add draft and publish behavior.
- Add asset upload validation.
- Add mock seed data.

### Testing

- Admin permission test.
- Unauthorized update test.
- Upload test.
- Publish test.
- Restore published version test.
- Arabic/English field validation.

---

## Phase 3 — Header, hero, and visitor information

**Priority: P0**

### Tasks

- Restructure header.
- Add transparent-to-solid scroll state.
- Build mobile menu.
- Build hero.
- Add desktop/mobile media support.
- Add CTAs.
- Add quick information bar.
- Preserve login navigation.

### Testing

- Header scroll test.
- Mobile menu test.
- Keyboard test.
- CTA analytics test.
- Hero fallback test.
- Reduced-motion test.

---

## Phase 4 — About, brands, and shop explorer

**Priority: P0**

### Tasks

- Build editorial about section.
- Build brand logo carousel.
- Build shop/category filters.
- Add shop quick-view.
- Connect active commercial tenants.
- Add mock brand placeholders.

### Testing

- RTL carousel direction.
- Drag/swipe.
- Missing logo.
- Inactive tenant filtering.
- Search and category filters.
- Mobile card layout.

---

## Phase 5 — Large carousel, facilities, and gallery

**Priority: P1**

### Tasks

- Build 16:9 carousel.
- Add progress indicator.
- Add facilities cards.
- Build gallery layout.
- Build accessible lightbox.
- Add image categories.
- Add lazy loading.

### Testing

- Exact 16:9 ratio.
- Swipe and keyboard.
- Lightbox focus trap.
- Image loading performance.
- Empty gallery.
- Mobile image crop.

---

## Phase 6 — Location, leasing, and contact

**Priority: P0**

### Tasks

- Build map section.
- Lazy-load map.
- Add Google Maps and call actions.
- Build leasing CTA.
- Build leasing enquiry form.
- Store submissions.
- Add success/error states.
- Add contact/social section.
- Add footer.
- Add mobile quick actions.

### Testing

- Map fallback.
- Valid/invalid coordinates.
- Phone and WhatsApp links.
- Enquiry validation.
- Rate limiting.
- RLS.
- Mobile safe-area behavior.

---

## Phase 7 — SEO, analytics, accessibility, performance

**Priority: P0**

### Tasks

- Add metadata.
- Add structured data.
- Add analytics events.
- Optimize all images.
- Add caching.
- Review bundle impact.
- Run accessibility audit.
- Run Lighthouse.
- Verify locale alternates.
- Verify semantic HTML.

### Testing

- Lighthouse desktop/mobile.
- Keyboard-only navigation.
- Screen-reader landmarks.
- Core Web Vitals.
- Social preview.
- Structured data validation.

---

## Phase 8 — Production rollout

**Priority: P0**

### Tasks

- Upload final assets.
- Replace all mock content.
- Verify business details.
- Final Arabic proofreading.
- Final English proofreading.
- Confirm tenant logos and permissions.
- Test on production-like environment.
- Deploy through normal main-branch workflow.
- Smoke-test live page.
- Monitor errors.
- Rollback plan.

### Testing

- Production mobile.
- Production desktop.
- Map directions.
- Contact links.
- Login routes.
- Forms.
- Images.
- SEO metadata.
- Analytics events.

---

# 22. Definition of Done

The restructure is complete when:

- All required sections are implemented.
- Final assets can be uploaded from admin.
- Mock assets can be replaced without code changes.
- Arabic RTL and English LTR are fully supported.
- Header, hero, brand carousel, gallery, 16:9 carousel, map, and leasing CTA work correctly.
- Landing content is manageable through structured settings.
- Login and authenticated application routes remain unchanged.
- The page is responsive from 320 px to large desktop widths.
- Accessibility checks pass with no critical issues.
- Performance targets are reasonably met.
- SEO metadata and structured data are present.
- Enquiry submissions are stored securely.
- Lint, typecheck, test, and production build pass.
- The live page is smoke-tested after deployment.

---

# 23. Out of Scope for the First Release

- Native mobile application.
- Full tenant e-commerce.
- Online ordering from shops.
- Loyalty points.
- Indoor navigation.
- Live parking occupancy.
- Augmented reality.
- Full event ticketing.
- Multi-complex public microsites.

These may be considered in future phases.

---

# 24. Future Expansion

The architecture should allow future support for:

- Multiple Danat-managed commercial complexes.
- Dedicated shop detail pages.
- Offers and promotions.
- Events calendar.
- Featured seasonal campaigns.
- Store opening status.
- Indoor map.
- Public unit leasing availability.
- WhatsApp chatbot.
- Personalized visitor recommendations.
- PWA installation.
- Push notifications.

---

# 25. Final Product Direction

The landing page should feel like:

> A premium digital destination for a real commercial complex, powered by real tenant data and real property photography.

The priority sequence must remain:

> Place → Shops → Experience → Gallery → Directions → Leasing

The design must use the uploaded black-and-gold logo as its visual foundation, while the real complex images provide the warmth, scale, and authenticity of Danat Al Jahra.
