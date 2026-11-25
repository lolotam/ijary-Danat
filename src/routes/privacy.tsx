import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ShieldCheck,
  ArrowLeft,
  ArrowRight,
  Lock,
  Eye,
  FileText,
  Mail,
  Phone,
  MapPin,
  Instagram,
  Globe,
} from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { BrandLogo } from "@/components/BrandLogo";
import { ThemeToggle } from "@/components/ThemeToggle";

export const Route = createFileRoute("/privacy")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "سياسة الخصوصية | Privacy Policy — Danat Al Mustaqbal" },
      {
        name: "description",
        content: "سياسة الخصوصية وحماية البيانات في شركة دانة المستقبل العقارية",
      },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
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
            <ShieldCheck className="w-4 h-4 text-[#d4af37]" />
            <span>{isAr ? "حماية البيانات وأمن المعلومات" : "Data Protection & Privacy"}</span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-white">
            {isAr ? "سياسة الخصوصية" : "Privacy Policy"}
          </h1>
          <p className="text-sm sm:text-base text-[#a9a18e] max-w-2xl mx-auto leading-relaxed">
            {isAr
              ? "نلتزم في شركة دانة المستقبل العقارية بحماية خصوصيتك وأمن بياناتك الشخصية والمالية وفقاً للقوانين واللوائح المعمول بها في دولة الكويت."
              : "At Danat Al Mustaqbal Real Estate, we are committed to protecting your privacy and securing your personal and financial data in accordance with applicable laws in the State of Kuwait."}
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
              {isAr ? "مقدمة عامة" : "1. Introduction"}
            </h2>
            <p className="text-sm sm:text-base leading-relaxed text-[#d6d0c5]">
              {isAr
                ? "توضح هذه السياسة كيفية جمع واستخدام وحماية البيانات والمعلومات عند استخدامك لمنصة وموقع دانة المستقبل العقارية (Danat Al Mustaqbal Real Estate Management Platform)، سواء كنت زائرًا للموقع، أو مستأجرًا، أو ممثلاً تجاريًا."
                : "This policy outlines how Danat Al Mustaqbal Real Estate Management Platform collects, uses, and protects your information when you visit our portal or use our real estate and tenant services."}
            </p>
          </section>

          {/* SECTION 2 */}
          <section className="space-y-4">
            <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-3 border-b border-[#d4af37]/20 pb-3">
              <span className="flex items-center justify-center size-8 rounded-lg bg-[#d4af37]/15 text-[#f2cd60] text-sm font-bold">
                2
              </span>
              {isAr ? "البيانات التي نجمعها" : "2. Information We Collect"}
            </h2>
            <p className="text-sm leading-relaxed">
              {isAr
                ? "نقوم بجمع البيانات الضرورية لتقديم الخدمات العقارية، وإدارة عقود التأجير، وإصدار الفواتير:"
                : "We collect information necessary to manage real estate leases, generate invoices, and fulfill contractual obligations:"}
            </p>
            <ul className="grid gap-3 text-sm sm:text-base">
              <li className="flex items-start gap-3 p-3.5 rounded-xl border border-[#d4af37]/15 bg-white/[0.02]">
                <Eye className="w-5 h-5 text-[#f2cd60] shrink-0 mt-0.5" />
                <div>
                  <strong className="text-white block font-semibold">
                    {isAr ? "بيانات الهوية والتواصل:" : "Personal Identity & Contact Info:"}
                  </strong>
                  <span className="text-[#a9a18e] text-xs sm:text-sm">
                    {isAr
                      ? "الاسم الكامل، رقم الهوية/الرقم المدني، رقم الهاتف، البريد الإلكتروني، والعنوان."
                      : "Full name, Civil ID/National ID, phone number, email address, and official address."}
                  </span>
                </div>
              </li>
              <li className="flex items-start gap-3 p-3.5 rounded-xl border border-[#d4af37]/15 bg-white/[0.02]">
                <FileText className="w-5 h-5 text-[#f2cd60] shrink-0 mt-0.5" />
                <div>
                  <strong className="text-white block font-semibold">
                    {isAr ? "بيانات العقود والوحدات:" : "Lease & Property Data:"}
                  </strong>
                  <span className="text-[#a9a18e] text-xs sm:text-sm">
                    {isAr
                      ? "تفاصيل عقد الإيجار، رقم المحل/الوحدة، قيمة الإيجار، تاريخ الاستحقاق، والوثائق المرفقة."
                      : "Contract details, unit/shop numbers, rent amounts, due dates, and uploaded documents."}
                  </span>
                </div>
              </li>
              <li className="flex items-start gap-3 p-3.5 rounded-xl border border-[#d4af37]/15 bg-white/[0.02]">
                <Lock className="w-5 h-5 text-[#f2cd60] shrink-0 mt-0.5" />
                <div>
                  <strong className="text-white block font-semibold">
                    {isAr ? "معلومات الدفع والمعاملات:" : "Payment & Transaction Logs:"}
                  </strong>
                  <span className="text-[#a9a18e] text-xs sm:text-sm">
                    {isAr
                      ? "سجلات عمليات الدفع الإلكتروني عبر بوابة KNET / MyFatoorah وإيصالات التحصيل. (ملاحظة: لا نقوم بتخزين أرود كروت البنوك أو الأرقام السرية)."
                      : "Payment transaction references processed securely via MyFatoorah / KNET. (Note: We never store card CVVs or PIN numbers)."}
                  </span>
                </div>
              </li>
            </ul>
          </section>

          {/* HIGHLIGHT BOX */}
          <div className="p-5 sm:p-6 rounded-xl border border-[#d4af37]/40 bg-gradient-to-r from-[#d4af37]/10 via-[#0e0d0b] to-[#d4af37]/10 space-y-2">
            <div className="flex items-center gap-2 text-[#f2cd60] font-bold text-sm">
              <ShieldCheck className="w-5 h-5" />
              <span>{isAr ? "تعهد أمان المدفوعات" : "Payment Security Commitment"}</span>
            </div>
            <p className="text-xs sm:text-sm text-[#d6d0c5] leading-relaxed">
              {isAr
                ? "تتم جميع المعاملات المالية عبر شبكات مشفرة ومعتمدة من بنك الكويت المركزي ومزودي خدمات الدفع المرخصين (KNET / MyFatoorah)."
                : "All financial transactions are executed through encrypted networks compliant with Central Bank of Kuwait standards via licensed payment gateways."}
            </p>
          </div>

          {/* SECTION 3 */}
          <section className="space-y-3">
            <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-3 border-b border-[#d4af37]/20 pb-3">
              <span className="flex items-center justify-center size-8 rounded-lg bg-[#d4af37]/15 text-[#f2cd60] text-sm font-bold">
                3
              </span>
              {isAr ? "كيفية استخدام البيانات" : "3. How We Use Your Data"}
            </h2>
            <p className="text-sm sm:text-base leading-relaxed text-[#d6d0c5]">
              {isAr
                ? "نستخدم البيانات المحفوظة للأغراض التالية فقط:"
                : "We utilize your personal information strictly for the following operational purposes:"}
            </p>
            <ul className="list-disc list-inside space-y-2 text-sm sm:text-base text-[#a9a18e] leading-relaxed">
              <li>
                {isAr
                  ? "إصدار وإرسال الفواتير وإيصالات السداد الشهرية."
                  : "Generating monthly rent invoices and payment receipts."}
              </li>
              <li>
                {isAr
                  ? "إرسال التنبيهات وإشعارات الاستحقاق عبر البريد الإلكتروني والواتساب."
                  : "Sending automated due date reminders via Email and WhatsApp."}
              </li>
              <li>
                {isAr
                  ? "إدارة طلبات التأجير وتوثيق العقود والوثائق الرسمية."
                  : "Managing leasing inquiries, contract renewals, and tenant records."}
              </li>
              <li>
                {isAr
                  ? "تقديم الدعم الفني واستقبال البلاغات والاستفسارات."
                  : "Providing customer care, maintenance tracking, and technical support."}
              </li>
            </ul>
          </section>

          {/* SECTION 4 */}
          <section className="space-y-3">
            <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-3 border-b border-[#d4af37]/20 pb-3">
              <span className="flex items-center justify-center size-8 rounded-lg bg-[#d4af37]/15 text-[#f2cd60] text-sm font-bold">
                4
              </span>
              {isAr ? "مشاركة البيانات مع أطراف ثالثة" : "4. Sharing Data with Third Parties"}
            </h2>
            <p className="text-sm sm:text-base leading-relaxed text-[#d6d0c5]">
              {isAr
                ? "لا نقوم ببيع أو تأجير بياناتك الشخصية لأي طرف ثالث. تشارك البيانات فقط مع المزودين المعتمدين والمباشرين لخدمات النظام (مثل بوابات الدفع الإلكتروني kNET، ومزودي الرسائل النواقل كـ Twilio / Resend) لأغراض التشغيل الفعلي."
                : "We do not sell or trade your personal data. We only share necessary parameters with authorized operational partners (e.g. MyFatoorah for payments, Twilio/Resend for notifications) solely to render our services."}
            </p>
          </section>

          {/* SECTION 5 */}
          <section className="space-y-3">
            <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-3 border-b border-[#d4af37]/20 pb-3">
              <span className="flex items-center justify-center size-8 rounded-lg bg-[#d4af37]/15 text-[#f2cd60] text-sm font-bold">
                5
              </span>
              {isAr ? "حقوقك وتحديث البيانات" : "5. Your Rights & Data Access"}
            </h2>
            <p className="text-sm sm:text-base leading-relaxed text-[#d6d0c5]">
              {isAr
                ? "يحق للمستأجرين والمستخدمين الاطلاع على بياناتهم المسجلة، وطلب تحديثها، أو تقديم طلب استفسار عبر إدارة شركة دانة المستقبل العقارية في أي وقت."
                : "Tenants and authorized users reserve the right to inspect their registered records, request corrections, or contact administration regarding stored details."}
            </p>
          </section>

          {/* CONTACT FOOTER IN CARD */}
          <div className="pt-6 border-t border-[#d4af37]/20 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[#a9a18e]">
            <p>
              {isAr
                ? "لأي استفسارات بخصوص سياسة الخصوصية، يرجى التواصل معنا:"
                : "For privacy inquiries, please contact our administration:"}
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
                  <Link to="/privacy" className="text-[#f2cd60] font-bold">
                    {isAr ? "سياسة الخصوصية" : "Privacy Policy"}
                  </Link>
                </li>
                <li>
                  <Link to="/terms" className="hover:text-[#f2cd60] transition-colors">
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
              <Link to="/privacy" className="text-[#f2cd60] hover:underline">
                {isAr ? "سياسة الخصوصية" : "Privacy Policy"}
              </Link>
              <span>•</span>
              <Link to="/terms" className="hover:text-[#f2cd60] hover:underline">
                {isAr ? "الشروط والأحكام" : "Terms of Service"}
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
