import { createFileRoute, Link } from "@tanstack/react-router";
import {
  FileText,
  ArrowLeft,
  ArrowRight,
  Scale,
  CheckCircle2,
  AlertCircle,
  Building2,
} from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { BrandLogo } from "@/components/BrandLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { brandNameFor, getPublicBranding } from "@/fns/publicBranding";

export const Route = createFileRoute("/terms")({
  ssr: false,
  // The host's company names the page, read on the server from the host —
  // never a fixed company — and the platform host gets the platform name.
  loader: async () => ({ branding: await getPublicBranding() }),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `الشروط والأحكام | Terms of Service — ${loaderData.branding.nameEn}`
          : "الشروط والأحكام | Terms of Service",
      },
      {
        name: "description",
        content: loaderData
          ? `الشروط والأحكام لاستخدام منصة وبوابة ${loaderData.branding.nameAr}`
          : "الشروط والأحكام",
      },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  const { t, locale, toggle } = useI18n();
  const isAr = locale === "ar";
  const year = new Date().getFullYear();
  const { branding } = Route.useLoaderData();
  const name = brandNameFor(branding, locale) || t("brand.name");

  return (
    <div className="dark min-h-screen bg-background text-foreground font-sans transition-colors duration-300">
      {/* HEADER / NAVIGATION */}
      <header className="sticky top-0 z-50 border-b border-primary/20 bg-card/90 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-20 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3 group">
            <BrandLogo name={name} />
          </Link>

          <div className="flex items-center gap-3">
            <button
              onClick={toggle}
              className="px-3 py-1.5 rounded-lg border border-primary/30 bg-white/5 text-xs font-semibold text-accent transition-all hover:bg-primary/15 hover:border-primary"
            >
              {isAr ? "English" : "العربية"}
            </button>
            <ThemeToggle />
            <Link
              to="/"
              className="hidden sm:inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/15 border border-primary/40 text-accent text-xs font-bold transition-all hover:bg-primary hover:text-primary-foreground"
            >
              {isAr ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
              {isAr ? "الرئيسية" : "Home"}
            </Link>
          </div>
        </div>
      </header>

      {/* HERO BANNER */}
      <section className="relative overflow-hidden border-b border-primary/15 bg-gradient-to-b from-card to-background py-16 sm:py-20">
        <div className="absolute inset-0 opacity-10 bg-[radial-gradient(var(--primary)_1px,transparent_1px)] [background-size:16px_16px]" />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center relative z-10 space-y-4">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-accent text-xs font-semibold shadow-inner">
            <Scale className="w-4 h-4 text-primary" />
            <span>
              {isAr ? "الاتفاقية القانونية وشروط الاستخدام" : "Legal Agreement & Terms of Service"}
            </span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-white">
            {isAr ? "الشروط والأحكام" : "Terms of Service"}
          </h1>
          <p className="text-sm sm:text-base text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            {isAr
              ? `تحكم هذه الاتفاقية استخدامك لمنصة ${name} وبوابة خدمات المستأجرين والخدمات الإلكترونية ذات الصلة.`
              : `These Terms of Service govern your access to and use of the ${name} platform and tenant services.`}
          </p>
          <div className="pt-2 text-xs text-muted-foreground/80">
            <span>{isAr ? "آخر تحديث: يوليو 2026" : "Last updated: July 2026"}</span>
          </div>
        </div>
      </section>

      {/* CONTENT BODY */}
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
        <div className="rounded-2xl border border-primary/25 bg-card/90 p-6 sm:p-12 shadow-2xl backdrop-blur-md space-y-10">
          {/* SECTION 1 */}
          <section className="space-y-3">
            <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-3 border-b border-primary/20 pb-3">
              <span className="flex items-center justify-center size-8 rounded-lg bg-primary/15 text-accent text-sm font-bold">
                1
              </span>
              {isAr ? "قبول الشروط" : "1. Acceptance of Terms"}
            </h2>
            <p className="text-sm sm:text-base leading-relaxed text-foreground">
              {isAr
                ? `دخولك أو استخدامك لمنصة وموقع ${name} يعتبر إقرارًا وموافقة كاملة منك على الالتزام بهذه الشروط والأحكام. إذا كنت لا توافق على أي بند، فيرجى التوقف عن استخدام الخدمات.`
                : `By accessing or using the ${name} platform and services, you agree to be bound by these terms. If you disagree with any part, you may not access our services.`}
            </p>
          </section>

          {/* SECTION 2 */}
          <section className="space-y-3">
            <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-3 border-b border-primary/20 pb-3">
              <span className="flex items-center justify-center size-8 rounded-lg bg-primary/15 text-accent text-sm font-bold">
                2
              </span>
              {isAr ? "وصف الخدمات" : "2. Scope of Services"}
            </h2>
            <p className="text-sm sm:text-base leading-relaxed text-foreground">
              {isAr
                ? `تقدم منصة ${name} خدمات إلكترونية شاملة تشمل:`
                : `${name} provides integrated real estate management solutions, including:`}
            </p>
            <ul className="grid gap-2 text-sm sm:text-base text-muted-foreground">
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-accent shrink-0" />
                <span>
                  {isAr
                    ? "عرض العقارات والمحلات التجارية وإدارة طلبات التأجير."
                    : "Property & shop listing management and leasing inquiry processing."}
                </span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-accent shrink-0" />
                <span>
                  {isAr
                    ? "إصدار وإدارة فواتير الإيجارات الشهرية والتنبيهات الآلية."
                    : "Issuance of monthly rent invoices and automated payment reminders."}
                </span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-accent shrink-0" />
                <span>
                  {isAr
                    ? "تحصيل Payments وإصدار الإيصالات عبر كي-نت (KNET / MyFatoorah)."
                    : "Payment collection and automated receipt generation via KNET / MyFatoorah."}
                </span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-accent shrink-0" />
                <span>
                  {isAr
                    ? "بوابة المستأجرين للاطلاع على العقود والمستندات والمدفوعات."
                    : "Tenant portal for inspecting contracts, documents, and historical payments."}
                </span>
              </li>
            </ul>
          </section>

          {/* SECTION 3 */}
          <section className="space-y-3">
            <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-3 border-b border-primary/20 pb-3">
              <span className="flex items-center justify-center size-8 rounded-lg bg-primary/15 text-accent text-sm font-bold">
                3
              </span>
              {isAr ? "التزامات المستخدم والمستأجر" : "3. Tenant & User Responsibilities"}
            </h2>
            <div className="space-y-3 text-sm sm:text-base text-muted-foreground">
              <p>
                {isAr
                  ? "يتعهد المستخدم بالآتي عند استخدام النظام:"
                  : "Users and tenants agree to fulfill the following obligations:"}
              </p>
              <ul className="list-disc list-inside space-y-2 leading-relaxed">
                <li>
                  {isAr
                    ? "تقديم بيانات دقيقة وصحيحة عند تقديم طلبات التأجير أو التسجيل."
                    : "Providing accurate and truthful information upon leasing registration."}
                </li>
                <li>
                  {isAr
                    ? "الحفاظ على سرية بيانات الدخول وكلمات المرور الخاصة ببوابة المستأجر."
                    : "Maintaining confidentiality of tenant portal login credentials."}
                </li>
                <li>
                  {isAr
                    ? "سداد قيمة الإيجارات والفواتير في مواعيد استحقاقها المحددة بالعقد."
                    : "Settling rental invoices on or before contractual due dates."}
                </li>
                <li>
                  {isAr
                    ? "عدم استخدام المنصة لأي أغراض غير قانونية أو مخالفة للوائح الكويتيّة."
                    : "Refraining from unauthorized or unlawful usage of the platform."}
                </li>
              </ul>
            </div>
          </section>

          {/* WARNING/IMPORTANT BOX */}
          <div className="p-5 sm:p-6 rounded-xl border border-primary/40 bg-muted space-y-2">
            <div className="flex items-center gap-2 text-accent font-bold text-sm">
              <AlertCircle className="w-5 h-5" />
              <span>
                {isAr ? "سداد الفواتير والشروط المالية" : "Rental Payments & Billing Policy"}
              </span>
            </div>
            <p className="text-xs sm:text-sm text-foreground leading-relaxed">
              {isAr
                ? "تعتبر الفواتير صادرة ومستحقة الدفع فور حلول تاريخ الإيجار الشهري. يتم توثيق جميع الدفعات الإلكترونية وإصدار إيصال رسمي رقمي ومؤرخ فور نجاح المعاملة."
                : "Rent invoices are due on the agreed monthly dates. Every electronic payment generates an official digital receipt immediately upon successful authorization."}
            </p>
          </div>

          {/* SECTION 4 */}
          <section className="space-y-3">
            <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-3 border-b border-primary/20 pb-3">
              <span className="flex items-center justify-center size-8 rounded-lg bg-primary/15 text-accent text-sm font-bold">
                4
              </span>
              {isAr ? "الملكية الفكرية" : "4. Intellectual Property"}
            </h2>
            <p className="text-sm sm:text-base leading-relaxed text-foreground">
              {isAr
                ? `جميع الحقوق الفكرية، والعلامات التجارية، والشعارات، والتصاميم، والأكواد المصدرية الخاصة بـ${name} هي ملك حصري لأصحابها ومحمية بموجب قوانين الملكية الفكرية.`
                : `All intellectual property rights, trade names, logos, branding assets, and system software of ${name} are exclusive property protected under applicable Kuwaiti law.`}
            </p>
          </section>

          {/* SECTION 5 */}
          <section className="space-y-3">
            <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-3 border-b border-primary/20 pb-3">
              <span className="flex items-center justify-center size-8 rounded-lg bg-primary/15 text-accent text-sm font-bold">
                5
              </span>
              {isAr ? "القانون الواجب التطبيق والافتضاض" : "5. Governing Law & Jurisdiction"}
            </h2>
            <p className="text-sm sm:text-base leading-relaxed text-foreground">
              {isAr
                ? "تخضع هذه الشروط والأحكام وتُفسر وفقاً لقوانين دولة الكويت، وتكون المحاكم الكويتية هي المختصة حصريًا بنظر أي نزاع قد ينشأ عنها."
                : "These terms shall be governed by and construed in accordance with the laws of the State of Kuwait, and the courts of Kuwait shall have exclusive jurisdiction."}
            </p>
          </section>

          {/* CONTACT FOOTER IN CARD */}
          {/* No fixed contact address here: it used to be one company's mailbox,
              shown on every company's page. */}
          <div className="pt-6 border-t border-primary/20 text-xs text-muted-foreground">
            <p>
              {isAr
                ? `لأي استفسارات قانونية أو إدارية بخصوص الشروط والأحكام، يرجى التواصل مع إدارة ${name}.`
                : `For legal or administration inquiries regarding these terms, please contact the administration of ${name}.`}
            </p>
          </div>
        </div>
      </main>

      {/* FOOTER */}
      <footer className="border-t border-primary/20 bg-background py-12 text-foreground">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid gap-8 md:grid-cols-12 pb-8 border-b border-primary/15">
            <div className="md:col-span-5 space-y-3">
              <BrandLogo name={name} />
              <p className="text-xs text-muted-foreground max-w-sm leading-relaxed">
                {isAr
                  ? `${name} — إدارة العقارات والمجمعات التجارية والحلول الرقمية المتكاملة.`
                  : `${name} — Property management and digital real estate solutions.`}
              </p>
            </div>
            <div className="md:col-span-3 space-y-2 text-xs">
              <h4 className="font-bold text-white text-sm mb-3">
                {isAr ? "روابط سريعة" : "Quick Links"}
              </h4>
              <ul className="space-y-2">
                <li>
                  <Link to="/" className="hover:text-accent transition-colors">
                    {isAr ? "الرئيسية" : "Home"}
                  </Link>
                </li>
                <li>
                  <Link to="/privacy" className="hover:text-accent transition-colors">
                    {isAr ? "سياسة الخصوصية" : "Privacy Policy"}
                  </Link>
                </li>
                <li>
                  <Link to="/terms" className="text-accent font-bold">
                    {isAr ? "الشروط والأحكام" : "Terms of Service"}
                  </Link>
                </li>
              </ul>
            </div>
            <div className="md:col-span-4 space-y-2 text-xs">
              <h4 className="font-bold text-white text-sm mb-3">{isAr ? "التواصل" : "Contact"}</h4>
              <p className="text-muted-foreground">{isAr ? "دولة الكويت" : "State of Kuwait"}</p>
            </div>
          </div>
          <div className="pt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-muted-foreground">
            <p>
              © {year} — {isAr ? "جميع الحقوق محفوظة" : "All rights reserved"} | {name}
            </p>
            <div className="flex items-center gap-4">
              <Link to="/privacy" className="hover:text-accent hover:underline">
                {isAr ? "سياسة الخصوصية" : "Privacy Policy"}
              </Link>
              <span>•</span>
              <Link to="/terms" className="text-accent hover:underline">
                {isAr ? "الشروط والأحكام" : "Terms of Service"}
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
