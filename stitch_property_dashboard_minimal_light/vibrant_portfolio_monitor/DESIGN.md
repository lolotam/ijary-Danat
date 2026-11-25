---
name: Vibrant Portfolio Monitor
colors:
  surface: "#f8f9ff"
  surface-dim: "#cbdbf5"
  surface-bright: "#f8f9ff"
  surface-container-lowest: "#ffffff"
  surface-container-low: "#eff4ff"
  surface-container: "#e5eeff"
  surface-container-high: "#dce9ff"
  surface-container-highest: "#d3e4fe"
  on-surface: "#0b1c30"
  on-surface-variant: "#434655"
  inverse-surface: "#213145"
  inverse-on-surface: "#eaf1ff"
  outline: "#737686"
  outline-variant: "#c3c6d7"
  surface-tint: "#0053db"
  primary: "#004ac6"
  on-primary: "#ffffff"
  primary-container: "#2563eb"
  on-primary-container: "#eeefff"
  inverse-primary: "#b4c5ff"
  secondary: "#006c49"
  on-secondary: "#ffffff"
  secondary-container: "#6cf8bb"
  on-secondary-container: "#00714d"
  tertiary: "#943700"
  on-tertiary: "#ffffff"
  tertiary-container: "#bc4800"
  on-tertiary-container: "#ffede6"
  error: "#ba1a1a"
  on-error: "#ffffff"
  error-container: "#ffdad6"
  on-error-container: "#93000a"
  primary-fixed: "#dbe1ff"
  primary-fixed-dim: "#b4c5ff"
  on-primary-fixed: "#00174b"
  on-primary-fixed-variant: "#003ea8"
  secondary-fixed: "#6ffbbe"
  secondary-fixed-dim: "#4edea3"
  on-secondary-fixed: "#002113"
  on-secondary-fixed-variant: "#005236"
  tertiary-fixed: "#ffdbcd"
  tertiary-fixed-dim: "#ffb596"
  on-tertiary-fixed: "#360f00"
  on-tertiary-fixed-variant: "#7d2d00"
  background: "#f8f9ff"
  on-background: "#0b1c30"
  surface-variant: "#d3e4fe"
  collection-blue: "#2563EB"
  payment-emerald: "#10B981"
  alert-amber: "#F59E0B"
  property-purple: "#8B5CF6"
  status-orange: "#F97316"
  surface-gray: "#F8FAFC"
  border-subtle: "#E2E8F0"
typography:
  display:
    fontFamily: Inter
    fontSize: 30px
    fontWeight: "700"
    lineHeight: 38px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: "700"
    lineHeight: 32px
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: "600"
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: "400"
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: "400"
    lineHeight: 20px
  label-caps:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: "700"
    lineHeight: 16px
    letterSpacing: 0.05em
  stat-value:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: "700"
    lineHeight: 32px
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: "700"
    lineHeight: 28px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  container-max: 600px
  stack-gap: 1.5rem
  card-padding: 1.25rem
  inline-gap: 0.75rem
  section-margin: 2.5rem
---

## Brand & Style

This design system is engineered for a high-end real estate management experience, optimized for the constraints of email clients while maintaining the sophistication of a modern dashboard. The personality is **energetic, professional, and authoritative**, utilizing a multi-colored card-based architecture to categorize complex financial and operational data at a glance.

The visual style is **Modern / Corporate with a playful edge**. It relies on a "clean-vibrant" contrast: a neutral, airy background allows saturated, functional color blocks to guide the user's eye. The interface prioritizes clarity and density, ensuring that property managers can digest critical status updates (collections, payments, and alerts) instantly. A core requirement is bi-directional support, with layout and typography designed to feel native in both English (LTR) and Arabic (RTL) contexts.

## Colors

The palette uses a **functional color-coding system** to drive information hierarchy:

- **Collection Blue (#2563EB):** Used for primary financial inflows and revenue tracking.
- **Payment Emerald (#10B981):** Signals successful deposits, completed maintenance payments, and positive growth.
- **Alert Amber (#F59E0B):** Reserved for overdue rent, expiring contracts, or pending approvals.
- **Property Purple (#8B5CF6) & Status Orange (#F97316):** Used for categorical data like unit types and tenant engagement levels.

The background should remain a crisp white or very light `surface-gray` to prevent the vibrant cards from feeling overwhelming. For RTL/Arabic text, ensure the color-coding remains consistent in mirrored layouts.

## Typography

**Inter** is selected for its exceptional legibility in both small-scale data tables and large-scale headers. It provides a systematic, utilitarian feel that balances the vibrant color palette.

- **Financial Data:** Large monetary values (e.g., total collections) use `stat-value` to command immediate attention.
- **Bi-directional Support:** For Arabic text, line heights are slightly increased (+10-15%) compared to English to accommodate the script's taller ascenders and descenders without crowding.
- **Hierarchy:** Use `label-caps` for section identifiers (e.g., "MONTHLY SUMMARY") to provide a clear structural anchor.

## Layout & Spacing

The layout follows a **Fixed Grid** model optimized for email clients, centered on a 600px container.

- **Vertical Rhythm:** Elements are stacked with a consistent `stack-gap` (24px). Large sections are separated by `section-margin` (40px) to give the report "room to breathe."
- **RTL Reflow:** On RTL (Arabic) viewports, the horizontal axis is completely flipped. Icons that denote direction (like arrows) must be mirrored, but functional status icons (like a checkmark or alert) remain standard.
- **Card System:** Information is grouped into cards. For desktop/large screens, cards can sit 2-abreast. On mobile, they reflow into a single column stack to maintain readability.

## Elevation & Depth

This design system uses **Ambient Shadows** and **Tonal Layers** to create a dashboard feel within a flat email environment.

- **Level 1 (Cards):** Cards use a soft, wide-dispersion shadow (Y: 4px, Blur: 12px, 5% opacity black) to lift them from the background.
- **Level 2 (Interactive/Highlight):** Buttons and active status chips use a slightly deeper shadow or a subtle inner glow to indicate "pressability."
- **Color Depth:** Functional cards use a subtle 1px border colored with a 20% opacity version of their primary functional color (e.g., a Blue card gets a light blue border) to define its bounds without looking heavy.

## Shapes

The design uses a **Rounded** language to soften the data-heavy nature of property management reports.

- **Cards:** All report cards must use a consistent 16px (`rounded-lg`) corner radius.
- **Buttons & Chips:** Use a 12px radius for secondary buttons and a full pill-shape for status tags/labels.
- **Consistency:** If an image is used (e.g., a property thumbnail), it must mirror the 16px card radius to maintain visual harmony.

## Components

- **Vibrant Summary Cards:** The hero of the report. A solid top-border (4px) in the functional color (Blue/Green/Amber) should be used. Title and Value should be clearly separated.
- **Status Chips:** Small, pill-shaped indicators with high-contrast text against a 15% opacity background of the functional color.
- **Data Rows:** For listing units or tenants, use a horizontal layout with a subtle bottom divider. In RTL mode, the property name stays on the right, and the value/price moves to the left.
- **Action Buttons:** Large, 16px rounded buttons. The primary CTA (e.g., "View Full Report") should use the primary brand blue with white text.
- **Alert Banners:** Used for critical system notifications, featuring a 2px stroke in `alert-amber` and a small icon at the start (right for RTL, left for LTR).
- **Metric Grids:** 2x2 grids for mobile, reflowing to 4x1 for desktop, used for quick-glance statistics like "Occupancy Rate" or "Pending Maintenance."
