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

export const Route = createFileRoute("/terms")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "الشروط والأحكام | Terms of Service — Danat Al Mustaqbal" },
      {
        name: "description",
        content: "الشروط والأحكام لاستخدام منصة وبوابة دانة المستقبل العقارية",
      },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  const { t, locale, dir, toggle } = useI18n();
  const isAr = locale === "ar";
  const year = new Date().getFullYear();

  return (
    <div className="min-h-screen bg-[#0a0a08] text-[#d6d0c5] font-sans selection:bg-[#d4af37]/30 selection:text-[#f2cd60] transition-colors duration-300">
      {/* HEADER / NAVIGATION */}
      <header className="sticky top-0 z-50 border-b border-[#d4af37]/20 bg-[#0e0d0b]/90 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-20 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-3 group">
            <BrandLogo name={t("brand.name")} />
          </Link>

          <div className="flex items-center gap-3">
            <button
              onClick={toggle}
              className="px-3 py-1.5 rounded-lg border border-[#d4af37]/30 bg-white/5 text-xs font-semibold text-[#f2cd60] transition-all hover:bg-[#d4af37]/15 hover:border-[#d4af37]"
            >
              {isAr ? "English" : "العربية"}
            </button>
            <ThemeToggle />
            <Link
              to="/"
              className="hidden sm:inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#d4af37]/15 border border-[#d4af37]/40 text-[#f2cd60] text-xs font-bold transition-all hover:bg-[#d4af37] hover:text-[#171204]"
            >
              {isAr ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
              {isAr ? "الرئيسية" : "Home"}
            </Link>
          </div>
        </div>
      </header>

      {/* HERO BANNER */}
      <section className="relative overflow-hidden border-b border-[#d4af37]/15 bg-gradient-to-b from-[#14120e] to-[#0a0a08] py-16 sm:py-20">
        <div className="absolute inset-0 opacity-10 bg-[radial-gradient(#d4af37_1px,transparent_1px)] [background-size:16px_16px]" />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center relative z-10 space-y-4">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-[#d4af37]/30 bg-[#d4af37]/10 text-[#f2cd60] text-xs font-semibold shadow-inner">
            <Scale className="w-4 h-4 text-[#d4af37]" />
            <span>
              {isAr ? "الاتفاقية القانونية وشروط الاستخدام" : "Legal Agreement & Terms of Service"}
            </span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-white">
            {isAr ? "الشروط والأحكام" : "Terms of Service"}
          </h1>
          <p className="text-sm sm:text-base text-[#a9a18e] max-w-2xl mx-auto leading-relaxed">
            {isAr
              ? "تحكم هذه الاتفاقية استخدامك لمنصة دانة المستقبل العقارية وبوابة خدمات المستأجرين والخدمات الإلكترونية ذات الصلة."
              : "These Terms of Service govern your access to and use of Danat Al Mustaqbal Real Estate Management Platform and tenant services."}
          </p>
          <div className="pt-2 text-xs text-[#a9a18e]/80">
            <span>{isAr ? "آخر تحديث: يوليو 2026" : "Last updated: July 2026"}</span>
          </div>
        </div>
      </section>

      {/* CONTENT BODY */}
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
        <div className="rounded-2xl border border-[#d4af37]/25 bg-[#0e0d0b]/90 p-6 sm:p-12 shadow-2xl backdrop-blur-md space-y-10">
          {/* SECTION 1 */}
          <section className="space-y-3">
            <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-3 border-b border-[#d4af37]/20 pb-3">
              <span className="flex items-center justify-center size-8 rounded-lg bg-[#d4af37]/15 text-[#f2cd60] text-sm font-bold">
                1
              </span>
              {isAr ? "قبول الشروط" : "1. Acceptance of Terms"}
            </h2>
            <p className="text-sm sm:text-base leading-relaxed text-[#d6d0c5]">
              {isAr
                ? "دخولك أو استخدامك لمنصة وموقع دانة المستقبل العقارية يعتبر إقرارًا وموافقة كاملة منك على الالتزام بهذه الشروط والأحكام. إذا كنت لا توافق على أي بند، فيرجى التوقف عن استخدام الخدمات."
                : "By accessing or using the Danat Al Mustaqbal Real Estate platform and services, you agree to be bound by these terms. If you disagree with any part, you may not access our services."}
            </p>
          </section>

          {/* SECTION 2 */}
          <section className="space-y-3">
            <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-3 border-b border-[#d4af37]/20 pb-3">
              <span className="flex items-center justify-center size-8 rounded-lg bg-[#d4af37]/15 text-[#f2cd60] text-sm font-bold">
                2
              </span>
              {isAr ? "وصف الخدمات" : "2. Scope of Services"}
            </h2>
            <p className="text-sm sm:text-base leading-relaxed text-[#d6d0c5]">
              {isAr
                ? "تقدم منصة دانة المستقبل العقارية خدمات إلكترونية شاملة تشمل:"
                : "Danat Al Mustaqbal Real Estate provides integrated real estate management solutions, including:"}
            </p>
            <ul className="grid gap-2 text-sm sm:text-base text-[#a9a18e]">
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-[#f2cd60] shrink-0" />
                <span>
                  {isAr
                    ? "عرض العقارات والمحلات التجارية وإدارة طلبات التأجير."
                    : "Property & shop listing management and leasing inquiry processing."}
                </span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-[#f2cd60] shrink-0" />
                <span>
                  {isAr
                    ? "إصدار وإدارة فواتير الإيجارات الشهرية والتنبيهات الآلية."
                    : "Issuance of monthly rent invoices and automated payment reminders."}
                </span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-[#f2cd60] shrink-0" />
                <span>
                  {isAr
                    ? "تحصيل Payments وإصدار الإيصالات عبر كي-نت (KNET / MyFatoorah)."
                    : "Payment collection and automated receipt generation via KNET / MyFatoorah."}
                </span>
              </li>
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-[#f2cd60] shrink-0" />
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
            <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-3 border-b border-[#d4af37]/20 pb-3">
              <span className="flex items-center justify-center size-8 rounded-lg bg-[#d4af37]/15 text-[#f2cd60] text-sm font-bold">
                3
              </span>
              {isAr ? "التزامات المستخدم والمستأجر" : "3. Tenant & User Responsibilities"}
            </h2>
            <div className="space-y-3 text-sm sm:text-base text-[#a9a18e]">
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
          <div className="p-5 sm:p-6 rounded-xl border border-[#d4af37]/40 bg-[#14120e] space-y-2">
            <div className="flex items-center gap-2 text-[#f2cd60] font-bold text-sm">
              <AlertCircle className="w-5 h-5" />
              <span>
                {isAr ? "سداد الفواتير والشروط المالية" : "Rental Payments & Billing Policy"}
              </span>
            </div>
            <p className="text-xs sm:text-sm text-[#d6d0c5] leading-relaxed">
              {isAr
                ? "تعتبر الفواتير صادرة ومستحقة الدفع فور حلول تاريخ الإيجار الشهري. يتم توثيق جميع الدفعات الإلكترونية وإصدار إيصال رسمي رقمي ومؤرخ فور نجاح المعاملة."
                : "Rent invoices are due on the agreed monthly dates. Every electronic payment generates an official digital receipt immediately upon successful authorization."}
            </p>
          </div>

          {/* SECTION 4 */}
          <section className="space-y-3">
            <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-3 border-b border-[#d4af37]/20 pb-3">
              <span className="flex items-center justify-center size-8 rounded-lg bg-[#d4af37]/15 text-[#f2cd60] text-sm font-bold">
                4
              </span>
              {isAr ? "الملكية الفكرية" : "4. Intellectual Property"}
            </h2>
            <p className="text-sm sm:text-base leading-relaxed text-[#d6d0c5]">
              {isAr
                ? "جميع الحقوق الفكرية، والعلامات التجارية، والشعارات، والتصاميم، والأكواد المصدرية الخاصة بشركة دانة المستقبل العقارية هي ملك حصري للشركة ومحمية بموجب قوانين الملكية الفكرية."
                : "All intellectual property rights, trade names, logos, branding assets, and system software of Danat Al Mustaqbal are exclusive property protected under applicable Kuwaiti law."}
            </p>
          </section>

          {/* SECTION 5 */}
          <section className="space-y-3">
            <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-3 border-b border-[#d4af37]/20 pb-3">
              <span className="flex items-center justify-center size-8 rounded-lg bg-[#d4af37]/15 text-[#f2cd60] text-sm font-bold">
                5
              </span>
              {isAr ? "القانون الواجب التطبيق والافتضاض" : "5. Governing Law & Jurisdiction"}
            </h2>
            <p className="text-sm sm:text-base leading-relaxed text-[#d6d0c5]">
              {isAr
                ? "تخضع هذه الشروط والأحكام وتُفسر وفقاً لقوانين دولة الكويت، وتكون المحاكم الكويتية هي المختصة حصريًا بنظر أي نزاع قد ينشأ عنها."
                : "These terms shall be governed by and construed in accordance with the laws of the State of Kuwait, and the courts of Kuwait shall have exclusive jurisdiction."}
            </p>
          </section>

          {/* CONTACT FOOTER IN CARD */}
          <div className="pt-6 border-t border-[#d4af37]/20 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[#a9a18e]">
            <p>
              {isAr
                ? "لأي استفسارات قانونية أو إدارية بخصوص الشروط والأحكام:"
                : "For legal or administration inquiries regarding these terms:"}
            </p>
            <a
              href="mailto:info@danat-future.com"
              className="px-4 py-2 rounded-lg border border-[#d4af37]/30 bg-[#d4af37]/10 text-[#f2cd60] font-bold hover:bg-[#d4af37] hover:text-[#171204] transition-all"
            >
              info@danat-future.com
            </a>
          </div>
        </div>
      </main>

      {/* FOOTER */}
      <footer className="border-t border-[#d4af37]/20 bg-[#070706] py-12 text-[#d6d0c5]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid gap-8 md:grid-cols-12 pb-8 border-b border-[#d4af37]/15">
            <div className="md:col-span-5 space-y-3">
              <BrandLogo name={t("brand.name")} />
              <p className="text-xs text-[#a9a18e] max-w-sm leading-relaxed">
                {isAr
                  ? "شركة دانة المستقبل العقارية — إدارة العقارات والمجمعات التجارية والحلول الرقمية المتكاملة."
                  : "Danat Al Mustaqbal Real Estate — Property management and digital real estate solutions."}
              </p>
            </div>
            <div className="md:col-span-3 space-y-2 text-xs">
              <h4 className="font-bold text-white text-sm mb-3">
                {isAr ? "روابط سريعة" : "Quick Links"}
              </h4>
              <ul className="space-y-2">
                <li>
                  <Link to="/" className="hover:text-[#f2cd60] transition-colors">
                    {isAr ? "الرئيسية" : "Home"}
                  </Link>
                </li>
                <li>
                  <Link to="/privacy" className="hover:text-[#f2cd60] transition-colors">
                    {isAr ? "سياسة الخصوصية" : "Privacy Policy"}
                  </Link>
                </li>
                <li>
                  <Link to="/terms" className="text-[#f2cd60] font-bold">
                    {isAr ? "الشروط والأحكام" : "Terms of Service"}
                  </Link>
                </li>
              </ul>
            </div>
            <div className="md:col-span-4 space-y-2 text-xs">
              <h4 className="font-bold text-white text-sm mb-3">{isAr ? "التواصل" : "Contact"}</h4>
              <p className="text-[#a9a18e]">
                {isAr ? "دولة الكويت — الجهراء" : "State of Kuwait — Al Jahra"}
              </p>
              <p className="text-[#a9a18e]">Email: info@danat-future.com</p>
            </div>
          </div>
          <div className="pt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[#a9a18e]">
            <p>
              © {year} — {isAr ? "جميع الحقوق محفوظة" : "All rights reserved"} | Danat Al Mustaqbal
              Real Estate.
            </p>
            <div className="flex items-center gap-4">
              <Link to="/privacy" className="hover:text-[#f2cd60] hover:underline">
                {isAr ? "سياسة الخصوصية" : "Privacy Policy"}
              </Link>
              <span>•</span>
              <Link to="/terms" className="text-[#f2cd60] hover:underline">
                {isAr ? "الشروط والأحكام" : "Terms of Service"}
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
