import os
import sys
import subprocess

# Auto-install python-docx if not present
try:
    import docx
except ImportError:
    print("python-docx not found. Installing...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "python-docx"])
    import docx

from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import qn, nsdecls

# --- XML Helper Functions for Advanced docx Styling ---

def set_cell_shading(cell, color_hex):
    """Applies a background fill color to a table cell."""
    shading_elm = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{color_hex}"/>')
    cell._tc.get_or_add_tcPr().append(shading_elm)

def set_cell_margins(cell, top=100, bottom=100, left=150, right=150):
    """Sets internal padding (margins) for a table cell in twentieths of a point (dxa)."""
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = OxmlElement('w:tcMar')
    for m, val in [('w:top', top), ('w:bottom', bottom), ('w:left', left), ('w:right', right)]:
        node = OxmlElement(m)
        node.set(qn('w:w'), str(val))
        node.set(qn('w:type'), 'dxa')
        tcMar.append(node)
    tcPr.append(tcMar)

def set_table_borders(table, color="CCCCCC", sz="4", val="single"):
    """Sets thin borders for the entire table."""
    tblPr = table._tbl.tblPr
    borders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>'
        f'  <w:top w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>'
        f'  <w:bottom w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>'
        f'  <w:left w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>'
        f'  <w:right w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>'
        f'  <w:insideH w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>'
        f'  <w:insideV w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>'
        f'</w:tblBorders>'
    )
    tblPr.append(borders)

def make_paragraph_rtl(paragraph):
    """Configures paragraph properties to enable RTL text layout."""
    pPr = paragraph._p.get_or_add_pPr()
    bidi = OxmlElement('w:bidi')
    bidi.set(qn('w:val'), '1')
    pPr.append(bidi)
    paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT

def make_run_rtl(run, font_name="Cairo"):
    """Applies complex script font configuration and RTL flag to a run."""
    rPr = run._r.get_or_add_rPr()
    
    # Enable RTL text direction for this text run
    rtl = OxmlElement('w:rtl')
    rtl.set(qn('w:val'), '1')
    rPr.append(rtl)
    
    # Configure font mapping for Complex Scripts (Arabic)
    rFonts = OxmlElement('w:rFonts')
    rFonts.set(qn('w:ascii'), font_name)
    rFonts.set(qn('w:hAnsi'), font_name)
    rFonts.set(qn('w:cs'), font_name)
    rPr.append(rFonts)
    
    run.font.name = font_name

def add_header_styled(doc, text, level, is_arabic=False):
    """Helper to add headings with specific brand colors and sizes."""
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(14)
    p.paragraph_format.space_after = Pt(6)
    p.paragraph_format.keep_with_next = True
    
    run = p.add_run(text)
    run.bold = True
    
    if level == 1:
        run.font.size = Pt(16)
        run.font.color.rgb = RGBColor(197, 158, 63) # Gold/Amber: #C59E3F
    elif level == 2:
        run.font.size = Pt(13)
        run.font.color.rgb = RGBColor(22, 25, 37)   # Dark Slate: #161925
    else:
        run.font.size = Pt(11.5)
        run.font.color.rgb = RGBColor(22, 25, 37)
        
    if is_arabic:
        make_paragraph_rtl(p)
        make_run_rtl(run, "Cairo")
    else:
        run.font.name = "Arial"
        
    return p

# --- Proposal Content Definitions ---

areas_en = [
    ("Landing Page", "Bilingual corporate page, brand/logo, video, contact form, chatbot placeholder, social links and Admin access"),
    ("Administration", "Dashboard, internal alerts, company/branding/banking settings and backup configuration"),
    ("Property Management", "Compounds, buildings, units, images/documents, unit statuses, electricity-meter ownership, filters and import/export"),
    ("Tenant & Contracts", "Automatic DANA code, tags, documents, investment/lease contracts, automatic dates, free periods and discounts"),
    ("Billing & Payments", "Monthly invoices, overdue/grace policies, partial/full payments, expenses, deposits, reversals and PDF receipts"),
    ("Tenant Portal", "Tenant Hero profile, contracts/payments, invoice visibility control, overdue-first payment and configurable receipt visibility"),
    ("Gateway", "MyFatoorah integration with KNET, Apple Pay and Google Pay, webhooks and secure payment verification"),
    ("Communications", "Email and WhatsApp, Arabic/English templates, reminders, receipts, notification pool, send/failure/retry history"),
    ("Reports & Security", "Payment, collection, expense, deposit and overdue reports; Excel/PDF/CSV; roles/permissions and audit log"),
    ("Deployment", "Self-hosted Supabase, Docker, Dokploy, backups, testing, documentation and training")
]

areas_ar = [
    ("الصفحة التعريفية", "صفحة تعريفية ثنائية اللغة، شعار وهوية الشركة، فيديو تعريفي، نموذج اتصل بنا، مساحة الشات بوت، روابط التواصل واختصار لوحة الإدارة"),
    ("لوحة الإدارة العامة", "لوحة تحكم للمدراء والمحصلين، الإشعارات والتنبيهات الداخلية، إعدادات بنوك وبيانات الشركة، ونظام جدولة النسخ الاحتياطي"),
    ("إدارة العقارات والوحدات", "المجمعات، المباني، الوحدات، صور ومستندات، حالات الوحدات، إثبات ملكية عداد الكهرباء، تصفيات الفلترة والتصدير والاستيراد"),
    ("المستأجرين والعقود", "رمز المستأجر التلقائي، تصنيف العملاء، مستودع المستندات، عقود الاستثمار والإيجار، حساب التواريخ تلقائياً، فترات السماح والخصم"),
    ("الفواتير والتحصيل المالي", "محرك توليد الفواتير الشهري، إعدادات المتأخرات، المدفوعات الجزئية والكاملة، المصروفات، الودائع البنكية، حركات التراجع وتصدير سندات PDF"),
    ("بوابة الخدمة الذاتية للعميل", "لوحة تحكم المستأجر، عقوده ومدفوعاته، التحكم في ظهور المطالبات، شرط السداد الترتيبي، والتحكم في صلاحية تحميل السندات"),
    ("بوابة الدفع (MyFatoorah)", "تكامل شامل مع كي نت وآبل باي وجوجل باي، روابط الدفع الإلكتروني، وتأكيد المعاملات الآلي عبر الـ Webhooks"),
    ("نظام الاتصالات والمراسلات", "رسائل البريد الإلكتروني والواتساب، قوالب ثنائية اللغة، إشعارات التحصيل والدفع، حوض الإشعارات وسجلات الإرسال وإعادة المحاولة"),
    ("التقارير والصلاحيات والحماية", "تقارير المدفوعات والتحصيلات والمصاريف والودائع، تصدير ملفات Excel/PDF/CSV، أدوار وصلاحيات الموظفين، وسجلات التدقيق والمراقبة"),
    ("استضافة وتشغيل المنصة", "تجهيز خادم Supabase، حاويات Docker، لوحة Dokploy للتحكم بالاستضافة، فحص الأمان، النسخ الاحتياطي، توثيق الكود والتدريب")
]

phases_data_en = [
    {
        "num": 1,
        "phase": "Phase 1: Discovery & Foundation",
        "hours": 40,
        "scope": "Requirements analysis, bilingual UX/UI, project structure, self-hosted Supabase, baseline security, Dokploy and Docker setup",
        "items": [
            ("Requirements & Scope Discovery", "Technical spec modeling, data relationship verification, & business logic alignment (8 hrs)"),
            ("Bilingual UX/UI Wireframes", "Designing responsive layouts, brand systems, and forms in Arabic/English (10 hrs)"),
            ("Project Architecture Setup", "Scaffolding the Expo and server repositories, code styles, and versioning protocols (6 hrs)"),
            ("Supabase & Docker Configuration", "Installing database containers, configuring schema migrations & RLS baseline policies (10 hrs)"),
            ("Environment Deployment & SSL", "Configuring VPS firewalls, Dokploy orchestration tool, staging builds & SSL routing (6 hrs)")
        ]
    },
    {
        "num": 2,
        "phase": "Phase 2: Properties, Tenants & Contracts",
        "hours": 65,
        "scope": "Company, compounds, buildings, units, documents, tenants, contracts, concessions, import/export",
        "items": [
            ("Property & Building Structures", "Compounds/buildings CRUD tables, commercial category settings, & default unit meter ownerships (15 hrs)"),
            ("Tenant Profiles & Consent Logic", "Unique DANA-{ID} code generator, status lifecycles, and WhatsApp notifications consent toggle (15 hrs)"),
            ("Secure Private Document Storage", "Private file buckets (Civil IDs, licenses) under UUID path obfuscation & expiring download links (10 hrs)"),
            ("Lease & Investment Contracts Engine", "Lease/Investment contract models, auto end-date calculator, renewals and audit-logged overrides (15 hrs)"),
            ("Concessions & Discounts Module", "Custom concession logic, discount allocations, and zero-value invoice item calculators (10 hrs)")
        ]
    },
    {
        "num": 3,
        "phase": "Phase 3: Invoices, Collections & Receipts",
        "hours": 75,
        "scope": "Monthly invoice engine, overdue states, full/partial payments, deposits, expenses, professional PDFs, audit trail",
        "items": [
            ("Idempotent Billing Core Engine", "Automated cron scheduling, monthly invoice generations with safety database locks (20 hrs)"),
            ("Billing Management UI Cards", "Grouped monthly invoice grids, building filters, states (Due/Paid/Waived) & badge UI (15 hrs)"),
            ("Overdue Processing & Grace Jobs", "Daily cron runs checking grace periods, converting visual states to red, & showing dashboard alerts (12 hrs)"),
            ("Manual Payments Ledger & Reversals", "Commercial/Personal ledger inputs (Cash, Cheque, Transfer), deposit verification, and immutable reversal logs (15 hrs)"),
            ("High-End PDF Receipt Generator", "Dynamic PDF layout engine including the mandatory 'قيمة استثمار' legal label (13 hrs)")
        ]
    },
    {
        "num": 4,
        "phase": "Phase 4: Tenant Portal & Online Payments",
        "hours": 85,
        "scope": "Web/iOS/Android portal, tenant login, chronological payment flow, MyFatoorah, KNET/Apple Pay/Google Pay, webhooks and receipts",
        "items": [
            ("Restricted Tenant Portal Dashboard", "Responsive web/mobile views for tenants checking lease, payment history, and profile updates (20 hrs)"),
            ("Chronological Billing Enforcer", "Enforcing oldest invoices to be cleared first via frontend component blocking & API validators (18 hrs)"),
            ("MyFatoorah Payment Gateway", "Payment request creation, merchant credentials check, & API integration for KNET/Apple/Google Pay (20 hrs)"),
            ("Secure Webhooks & Callback Handlers", "Verified webhook endpoints, signature decryption, idempotency logic, and automated ledger postings (15 hrs)"),
            ("Transaction Redirects & Screen States", "Post-payment callback processing, success/fail screen states, and payment recovery loops (12 hrs)")
        ]
    },
    {
        "num": 5,
        "phase": "Phase 5: Notifications, Reports & Permissions",
        "hours": 70,
        "scope": "WhatsApp/email, Arabic/English templates, notification pool, scheduled reports, RBAC and granular permissions",
        "items": [
            ("WhatsApp Cloud API Integration", "Opt-in confirmation, Meta API credentials, approved templates, and dynamic invoice reminder sends (20 hrs)"),
            ("SMTP/Resend Email Services", "Transactional emails config, template wrappers, and automated payment notifications (10 hrs)"),
            ("Notification Pool Queue Manager", "Centrally listing outbound logs, delivery statuses, retry limits, and failure reason logging (10 hrs)"),
            ("Manager Summary Reports Engine", "Scheduled manager emails (HTML tables) for daily collections, overdue logs, expenses & deposits (15 hrs)"),
            ("RBAC & Granular Security Policies", "Admin role custom definitions, permissions checks, API interceptors, & append-only audit trail logs (15 hrs)")
        ]
    },
    {
        "num": 6,
        "phase": "Phase 6: QA, Launch & Handover",
        "hours": 65,
        "scope": "Functional/security tests, fixes, Docker deployment, backup, documentation, training, UAT and initial launch",
        "items": [
            ("Functional & Security Testing", "Executing end-to-end integration tests, RLS verification, payment redirects, and webhook simulation (15 hrs)"),
            ("Bug Fixing & Hardening", "Resolving security feedback, frontend styling tweaks, edge cases, and performance optimizations (15 hrs)"),
            ("Backup & Disaster Recovery Setup", "Setting up daily encrypted database dumps & media storage backups outside the main VPS (10 hrs)"),
            ("Documentation & User Training", "Writing user manual, developer documentation, API blueprints, and staff training sessions (15 hrs)"),
            ("UAT Sign-off & Production Launch", "Manual historical Excel data cutover audit, manager sign-off, production Dokploy deploy & DNS (10 hrs)")
        ]
    }
]

phases_data_ar = [
    {
        "num": 1,
        "phase": "المرحلة الأولى: التحليل والتأسيس للمنصة",
        "hours": 40,
        "scope": "تحليل الاحتياجات الفنية، تصميم واجهات ثنائية اللغة، هيكلة المشروع، خادم Supabase، إعدادات الحماية الأساسية وتهيئة Docker و Dokploy",
        "items": [
            ("تحليل الاحتياجات وتوثيق النطاق", "تحديد الاحتياجات التقنية وتصميم العلاقات المالية وهيكل الجداول وقواعد العمل لضمان دقة التنفيذ (8 ساعات)"),
            ("تصميم واجهات المستخدم للمنصة", "رسم الواجهات التفاعلية ثنائية اللغة للوحة الإدارة العامة وبوابة المستأجرين وشاشات الدفع (10 ساعات)"),
            ("تأسيس البنية البرمجية والملفات", "بناء هيكل الكود لـ Expo وتطوير السيرفر، وتحديد أنماط البرمجة وإعداد نظام النسخ الاحتياطي الأولي (6 ساعات)"),
            ("تهيئة وتدشين Supabase وقاعدة البيانات", "تثبيت قواعد بيانات PostgreSQL، وإعداد الحقول والفهارس وقواعد RLS لمنع تداخل صلاحيات الوصول (10 ساعات)"),
            ("إعداد البيئة والخادم وتفعيل الحماية", "تهيئة خادم VPS، لوحة Dokploy، إرسال شهادات التشفير SSL وربط البيئة التجريبية للمشروع (6 ساعات)")
        ]
    },
    {
        "num": 2,
        "phase": "المرحلة الثانية: العقارات والمستأجرين والعقود",
        "hours": 65,
        "scope": "بيانات الشركة، المجمعات والمباني والوحدات، تخزين الملفات، ملفات المستأجرين والعقود والإعفاءات، وتصدير واستيراد البيانات",
        "items": [
            ("هيكلة المجمعات والمباني والوحدات", "برمجة شاشات المباني والوحدات، وتحديد تصنيف النشاط الاقتصادي وإثبات ملكية عداد الكهرباء (15 ساعة)"),
            ("ملفات المستأجرين وقواعد التواصل", "توليد رمز مستأجر فريد DANA-{ID} تلقائياً، إعداد حالات المستأجر وزر تفعيل تنبيهات الواتساب (15 ساعة)"),
            ("مستودع المستندات السحابي المؤمن", "إعداد حاويات التخزين المشفرة لملفات الهويات والرخص بروابط مشفرة مؤقتة تنتهي تلقائياً (10 ساعات)"),
            ("محرك عقود الاستثمار والإيجار", "تطوير شاشات العقود واحتساب تاريخ الانتهاء تلقائياً وخيارات التجميد أو التجديد مع توثيق التعديل يدوياً (15 ساعة)"),
            ("نظام الإعفاءات والخصومات للعقود", "برمجة دورات السماح (المجانية) والخصومات المئوية أو الثابتة ودمجها بآلية احتساب الفواتير تلقائياً (10 ساعات)")
        ]
    },
    {
        "num": 3,
        "phase": "المرحلة الثالثة: الفواتير وعمليات التحصيل والسندات",
        "hours": 75,
        "scope": "محرك الفواتير الشهري، إعدادات المتأخرات، السداد اليدوي والجزئي، المصروفات، الودائع البنكية، الإلغاء وسندات التحصيل PDF وسجلات المراقبة",
        "items": [
            ("محرك توليد الفواتير الشهري التلقائي", "برمجة سكريبت مجدول دوري لتوليد مطالبات الإيجار شهرياً بشكل ثابت يمنع التكرار (Idempotency) (20 ساعة)"),
            ("جداول وبطاقات الفواتير الشهرية", "تصميم شاشات عرض الشهور كبطاقات والبحث والفلترة حسب المباني، وحالات الفاتورة (مستحقة، مدفوعة، معفاة) (15 ساعة)"),
            ("نظام المتأخرات وفترات السماح", "برمجة التحديث اليومي للفواتير غير المدفوعة وتغيير حالتها إلى 'متأخرة' وإظهار جرس التنبيه باللوحة (12 ساعة)"),
            ("دفتر السداد اليدوي والتسويات المالية", "تسجيل المدفوعات يدوياً (نقدي، شيك، تحويل)، وتوثيق تسويات الحسابات وسجلات إثبات التراجعات (15 ساعة)"),
            ("مصمم سندات التحصيل بصيغة PDF", "إعداد آلية بناء سند التحصيل تفصيلياً مع إظهار الملاحظة القانونية 'قيمة استثمار' بشكل إلزامي (13 ساعة)")
        ]
    },
    {
        "num": 4,
        "phase": "المرحلة الرابعة: بوابة العميل وبوابات الدفع الإلكتروني",
        "hours": 85,
        "scope": "بوابة المستأجر (ويب وجوال)، تسجيل الدخول المحدود، سداد الفواتير ترتيبياً، دفع MyFatoorah (KNET/Apple/Google)، الـ Webhooks والسندات",
        "items": [
            ("بوابة المستأجر الإلكترونية المحدودة", "تطوير لوحة خدمة ذاتية للمستأجر لمراجعة عقده وتواريخ استحقاق الفواتير وتحميل سندات التحصيل (20 ساعة)"),
            ("شرط السداد الترتيبي الصارم للأقدم", "فرض القيود البرمجية على السداد (دفع الفواتير القديمة أولاً) على مستوى الواجهات وقواعد البيانات (18 ساعة)"),
            ("دمج بوابة الدفع الرقمية (MyFatoorah)", "توفير بوابات الدفع الإلكتروني KNET و Apple Pay و Google Pay والتحقق من الجلسات وقيمة المعاملة (20 ساعة)"),
            ("تلقي ومعالجة الـ Webhooks لضمان الأمان", "برمجة الروابط المرتجعة للتحقق من سلامة الدفع، منع التكرار، وتحديث حالة الفواتير في النظام فورياً (15 ساعة)"),
            ("صفحات التوجيه ودورة استرداد المدفوعات", "تصميم شاشات العودة بعد الدفع (نجاح/فشل المعاملة) ومسارات المعالجة التلقائية لحالات الانقطاع (12 ساعة)")
        ]
    },
    {
        "num": 5,
        "phase": "المرحلة الخامسة: المراسلات وحوض الإشعارات والصلاحيات",
        "hours": 70,
        "scope": "ربط الواتساب Cloud API والبريد، قوالب الرسائل، لوحة مراقبة الرسائل، تقارير المدراء المجدولة، صلاحيات الأدوار وسجلات التدقيق",
        "items": [
            ("ربط تطبيق WhatsApp Cloud API الرسمي", "برمجة القوالب الرسمية المعتمدة من Meta لإرسال التذكيرات التلقائية للفواتير والتحصيل فور السداد (20 ساعة)"),
            ("إعداد خدمات البريد الإلكتروني (SMTP/Resend)", "برمجة قوالب البريد الإلكتروني ثنائية اللغة لإرسال الإخطارات وتأكيد المعاملات وتحديث حالات العقود (10 ساعات)"),
            ("إدارة وإحصائيات حوض الإشعارات", "بناء لوحة لمراقبة الرسائل الصادرة، إعادة المحاولة التلقائية للفاشلة منها، وتوثيق تواريخ الاستلام (10 ساعات)"),
            ("محرك توليد التقارير المجدولة للمدراء", "توليد تقارير الإدارة الدورية تلقائياً (التحصيلات، المصاريف، المتأخرات) وإرسالها بالبريد كجدول HTML منسق (15 ساعة)"),
            ("نظام الصلاحيات وسجلات التدقيق (Audit Logs)", "تحديد أدوار الموظفين (محاسب، محصل)، تفعيل RLS، وبناء سجلappend-only للمراقبة الأمنية للعمليات المالية (15 ساعة)")
        ]
    },
    {
        "num": 6,
        "phase": "المرحلة السادسة: فحص الجودة، التشغيل وتسليم المشروع",
        "hours": 65,
        "scope": "اختبارات النظام والأمان، إصلاح الملاحظات، تشغيل خادم الإنتاج، إعداد النسخ الاحتياطي، توثيق النظام، وتدريب الموظفين والتسليم",
        "items": [
            ("اختبارات النظام والتحقق من الأمان", "تشغيل سيناريوهات الفحص الكامل للنظام، واختبار RLS، ومحاكاة عمليات الدفع والتحقق من الروابط (15 ساعة)"),
            ("إصلاح الملاحظات ومعالجة المشاكل", "معالجة أخطاء الفحص التجريبي، وتعديل تنسيقات الواجهات وسرعة أداء صفحات التحميل (15 ساعة)"),
            ("إعداد خادم الإنتاج والنسخ الاحتياطي الآمن", "إعداد النسخ الاحتياطي التلقائي والمشفر لقواعد البيانات والملفات ورفعها خارج السيرفر (10 ساعات)"),
            ("كتابة التوثيق وتدريب الموظفين", "كتابة دليل الاستخدام التفصيلي وتوثيق الكود الفني وتدريب المحاسبين والمحصلين على إدارة المنصة (15 ساعة)"),
            ("ترحيل بيانات Excel والتشغيل الرسمي للموقع", "تدقيق ونقل بيانات الإكسيل اليدوية ومطابقتها وتفعيل الحساب الرسمي وربط الدومين وبدء التشغيل (10 ساعات)")
        ]
    }
]

# --- Document Generation Functions ---

def create_english_proposal(filename):
    doc = Document()
    
    # Page setup
    for section in doc.sections:
        section.top_margin = Inches(1)
        section.bottom_margin = Inches(1)
        section.left_margin = Inches(1)
        section.right_margin = Inches(1)
        
    # Typography Setup
    style = doc.styles['Normal']
    font = style.font
    font.name = 'Arial'
    font.size = Pt(10.5)
    font.color.rgb = RGBColor(51, 51, 51) # Charcoal hex: #333333
    
    # Title / Header Block
    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_title.paragraph_format.space_before = Pt(36)
    p_title.paragraph_format.space_after = Pt(6)
    
    run_title = p_title.add_run("TECHNICAL & COMMERCIAL PROPOSAL")
    run_title.bold = True
    run_title.font.size = Pt(20)
    run_title.font.color.rgb = RGBColor(197, 158, 63) # Golden #C59E3F
    
    p_sub = doc.add_paragraph()
    p_sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_sub.paragraph_format.space_after = Pt(24)
    run_sub = p_sub.add_run("Real Estate Management Platform (ERMP)\nDevelopment & Integration Services")
    run_sub.font.size = Pt(12)
    run_sub.font.color.rgb = RGBColor(110, 115, 125)
    
    # Meta Details Box
    table_meta = doc.add_table(rows=4, cols=2)
    table_meta.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(table_meta, color="E5E7EB")
    
    meta_info = [
        ("Prepared For:", "Danat Al Mustaqbal Real Estate"),
        ("Prepared By:", "Pro Life Technical"),
        ("Date:", "July 2026"),
        ("Proposal Validity:", "30 Days from date of submission")
    ]
    
    for idx, (label, val) in enumerate(meta_info):
        row = table_meta.rows[idx]
        cell_lbl, cell_val = row.cells[0], row.cells[1]
        
        cell_lbl.text = ""
        p_lbl = cell_lbl.paragraphs[0]
        run_lbl = p_lbl.add_run(label)
        run_lbl.bold = True
        run_lbl.font.color.rgb = RGBColor(22, 25, 37)
        
        cell_val.text = ""
        p_val = cell_val.paragraphs[0]
        run_val = p_val.add_run(val)
        
        for c in [cell_lbl, cell_val]:
            set_cell_margins(c, top=80, bottom=80, left=120, right=120)
            set_cell_shading(c, "F9FAFB")
            
    doc.add_page_break()
    
    # Section 1: Project Overview
    add_header_styled(doc, "Project Overview", level=1)
    p = doc.add_paragraph(
        "Pro Life Technical is pleased to submit this proposal for a secure, integrated real-estate, "
        "rent-collection and tenant-management platform. The platform centralizes properties, units, tenants, "
        "contracts, invoices, payments and reports, with a dedicated tenant portal plus iOS, Android and Web delivery. "
        "This system is designed from the ground up to ensure absolute financial transparency, eliminate human errors, "
        "and automate rent collection in a strict chronological order."
    )
    p.paragraph_format.space_after = Pt(12)
    p.paragraph_format.line_spacing = 1.15
    
    # Section 2: Business Value
    add_header_styled(doc, "Business Value", level=1)
    business_values = [
        ("Centralization", "Centralize operations and data instead of relying on spreadsheets and manual follow-up."),
        ("Automation", "Automate overdue monitoring, collections, receipts and notifications."),
        ("Accountability", "Improve accuracy and accountability through a complete financial and operational audit trail."),
        ("Chronology", "Provide a secure tenant portal for payments in the required chronological order."),
        ("Growth", "Support company growth with roles, permissions and exportable reports.")
    ]
    for title, desc in business_values:
        p_val = doc.add_paragraph(style='List Bullet')
        p_val.paragraph_format.space_after = Pt(4)
        run_val_title = p_val.add_run(f"{title}: ")
        run_val_title.bold = True
        p_val.add_run(desc)

    # Section 3: Scope of Work & Key Features (Table 1)
    add_header_styled(doc, "Scope of Work & Key Features", level=1)
    
    table_areas = doc.add_table(rows=1, cols=2)
    table_areas.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(table_areas, color="D1D5DB")
    
    hdr_cells = table_areas.rows[0].cells
    hdr_cells[0].text = "Area"
    hdr_cells[1].text = "Features"
    for c in hdr_cells:
        set_cell_shading(c, "161925") # Dark Slate
        set_cell_margins(c, top=100, bottom=100, left=120, right=120)
        p_hdr = c.paragraphs[0]
        p_hdr.runs[0].bold = True
        p_hdr.runs[0].font.color.rgb = RGBColor(255, 255, 255)
        p_hdr.runs[0].font.size = Pt(10)
        
    for area, feat in areas_en:
        row = table_areas.add_row()
        cells = row.cells
        cells[0].text = area
        cells[0].paragraphs[0].runs[0].bold = True
        cells[1].text = feat
        for c in cells:
            set_cell_margins(c, top=80, bottom=80, left=120, right=120)
            c.paragraphs[0].runs[0].font.size = Pt(9.5)
            
    doc.add_paragraph().paragraph_format.space_after = Pt(12)
    
    # Section 4: Implementation Phases & Estimated Hours (Table 2)
    add_header_styled(doc, "Implementation Phases & Estimated Hours", level=1)
    p = doc.add_paragraph("Total implementation effort is exactly 400 working hours, distributed across 6 key delivery phases:")
    p.paragraph_format.space_after = Pt(8)
    
    table_phases = doc.add_table(rows=1, cols=4)
    table_phases.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(table_phases, color="D1D5DB")
    
    hdr_ph = table_phases.rows[0].cells
    hdr_ph[0].text = "Phase"
    hdr_ph[1].text = "Phase Name"
    hdr_ph[2].text = "Hours"
    hdr_ph[3].text = "Delivery Scope"
    
    for c in hdr_ph:
        set_cell_shading(c, "161925") # Dark Slate
        set_cell_margins(c, top=100, bottom=100, left=120, right=120)
        p_hdr = c.paragraphs[0]
        p_hdr.runs[0].bold = True
        p_hdr.runs[0].font.color.rgb = RGBColor(255, 255, 255)
        p_hdr.runs[0].font.size = Pt(10)
        
    for phase in phases_data_en:
        row = table_phases.add_row()
        cells = row.cells
        cells[0].text = str(phase["num"])
        cells[0].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
        cells[1].text = phase["phase"].split(": ")[-1]
        cells[1].paragraphs[0].runs[0].bold = True
        cells[2].text = f"{phase['hours']} hrs"
        cells[2].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT
        cells[3].text = phase["scope"]
        for c in cells:
            set_cell_margins(c, top=80, bottom=80, left=120, right=120)
            c.paragraphs[0].runs[0].font.size = Pt(9.5)
            
    doc.add_page_break()
    
    # Section 5: Commercial Investment
    add_header_styled(doc, "Commercial Investment", level=1)
    
    table_price = doc.add_table(rows=4, cols=2)
    table_price.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(table_price, color="CCCCCC")
    
    pricing_info = [
        ("Total effort", "400 hours"),
        ("Total project fee", "KWD 3,000"),
        ("Effective hourly value", "KWD 7.500 / hour"),
        ("Target delivery period", "Initially one month, subject to timely client approvals, accounts and data")
    ]
    
    for idx, (lbl, val) in enumerate(pricing_info):
        row = table_price.rows[idx]
        cell_lbl, cell_val = row.cells[0], row.cells[1]
        
        cell_lbl.text = ""
        p_lbl = cell_lbl.paragraphs[0]
        run_lbl = p_lbl.add_run(lbl)
        run_lbl.bold = True
        
        cell_val.text = ""
        p_val = cell_val.paragraphs[0]
        run_val = p_val.add_run(val)
        if "3,000" in val:
            run_val.bold = True
            run_val.font.color.rgb = RGBColor(197, 158, 63)
            
        for c in [cell_lbl, cell_val]:
            set_cell_margins(c, top=80, bottom=80, left=120, right=120)
            set_cell_shading(c, "F9FAFB" if idx % 2 == 0 else "FFFFFF")
            
    doc.add_paragraph().paragraph_format.space_after = Pt(12)
    
    # Excluded costs
    add_header_styled(doc, "Third-Party Costs Excluded", level=2)
    p = doc.add_paragraph(
        "Please note that the developer fees exclude direct costs associated with third-party providers. "
        "These expenses must be registered directly by the client and are billed separately by their respective providers:"
    )
    p.paragraph_format.space_after = Pt(6)
    
    exclusions = [
        "Server, domain registration, SSL certificates, and any paid hosting infrastructure charges.",
        "MyFatoorah gateway merchant account activation fees and per-transaction commission rates.",
        "WhatsApp Business API/provider transaction fees, such as Twilio, 360dialog, or Meta direct cloud API costs.",
        "Apple Developer and Google Play Developer fees if mobile store publication is required.",
        "Domain Registration & Subscription Expenses.",
        "Any external email provider, SMS gateways, cloud file storage, or additional third-party service charges."
    ]
    
    for desc in exclusions:
        p_bullet = doc.add_paragraph(style='List Bullet')
        p_bullet.paragraph_format.space_after = Pt(4)
        p_bullet.add_run(desc)
        
    doc.add_paragraph().paragraph_format.space_after = Pt(12)
    
    # Support & Maintenance
    add_header_styled(doc, "Support & Maintenance", level=1)
    support_items = [
        "Free correction of software defects within the approved scope for one full year from go-live.",
        "Basic operational follow-up and technical guidance during the first year at no additional charge.",
        "Free support excludes new features, material scope changes, provider-policy changes, and third-party charges.",
        "Any additional development request will be estimated and approved in a separate proposal before implementation."
    ]
    for desc in support_items:
        p_sup = doc.add_paragraph(style='List Bullet')
        p_sup.paragraph_format.space_after = Pt(4)
        p_sup.add_run(desc)

    doc.add_paragraph().paragraph_format.space_after = Pt(12)

    # Terms & Assumptions
    add_header_styled(doc, "Terms & Assumptions", level=1)
    terms_items = [
        "The initial one-month delivery target starts after proposal approval and receipt of required data, branding and service access.",
        "Timeline depends on timely approval of screens, Excel data, MyFatoorah credentials, WhatsApp setup and message templates.",
        "Historical Excel data will be manually entered, reviewed and reconciled with its source before go-live.",
        "Client provides final legal content, privacy policy, WhatsApp opt-ins and approval of the “Investment Value, Not Rent” wording.",
        "Online payments depend on the client’s MyFatoorah account approval and enabled payment methods.",
        "This proposal is valid for 30 days from issue date."
    ]
    for desc in terms_items:
        p_term = doc.add_paragraph(style='List Bullet')
        p_term.paragraph_format.space_after = Pt(4)
        p_term.add_run(desc)

    doc.add_paragraph().paragraph_format.space_after = Pt(24)
    
    # Signatures
    add_header_styled(doc, "Proposal Acceptance", level=1)
    p = doc.add_paragraph(
        "Pro Life Technical is committed to delivering a professional, scalable solution focused on financial accuracy, "
        "security and operational simplicity. We are ready to begin discovery and design upon acceptance."
    )
    p.paragraph_format.space_after = Pt(36)
    
    table_sig = doc.add_table(rows=3, cols=2)
    table_sig.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(table_sig, color="CCCCCC")
    
    sig_info = [
        ("Client Name", "____________________________"),
        ("Signature", "____________________________"),
        ("Date", "____________________________")
    ]
    
    for idx, (lbl, val) in enumerate(sig_info):
        row = table_sig.rows[idx]
        cell_lbl, cell_val = row.cells[0], row.cells[1]
        
        cell_lbl.text = ""
        p_lbl = cell_lbl.paragraphs[0]
        run_lbl = p_lbl.add_run(lbl)
        run_lbl.bold = True
        
        cell_val.text = ""
        p_val = cell_val.paragraphs[0]
        p_val.add_run(val)
        
        for c in [cell_lbl, cell_val]:
            set_cell_margins(c, top=80, bottom=80, left=120, right=120)
            set_cell_shading(c, "F9FAFB" if idx % 2 == 0 else "FFFFFF")
            
    doc.save(filename)
    print(f"Generated English Proposal: {filename}")


def create_arabic_proposal(filename):
    doc = Document()
    
    # Page setup
    for section in doc.sections:
        section.top_margin = Inches(1)
        section.bottom_margin = Inches(1)
        section.left_margin = Inches(1)
        section.right_margin = Inches(1)
        
    # Typography Setup (Normal Style defaults)
    style = doc.styles['Normal']
    font = style.font
    font.name = 'Cairo'
    font.size = Pt(10.5)
    font.color.rgb = RGBColor(51, 51, 51)
    
    # Title / Header Block
    p_title = doc.add_paragraph()
    make_paragraph_rtl(p_title)
    p_title.paragraph_format.space_before = Pt(36)
    p_title.paragraph_format.space_after = Pt(6)
    
    run_title = p_title.add_run("العرض الفني والمالي المتكامل لتنفيذ النظام")
    make_run_rtl(run_title, "Cairo")
    run_title.bold = True
    run_title.font.size = Pt(20)
    run_title.font.color.rgb = RGBColor(197, 158, 63) # Golden #C59E3F
    
    p_sub = doc.add_paragraph()
    make_paragraph_rtl(p_sub)
    p_sub.paragraph_format.space_after = Pt(24)
    run_sub = p_sub.add_run("منصة إدارة عقارات دانة المستقبل (ERMP)\nمقدم من: مؤسسة برو لايف تكنيكال")
    make_run_rtl(run_sub, "Cairo")
    run_sub.font.size = Pt(12)
    run_sub.font.color.rgb = RGBColor(110, 115, 125)
    
    # Meta Details Box
    table_meta = doc.add_table(rows=4, cols=2)
    table_meta.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(table_meta, color="E5E7EB")
    
    meta_info = [
        ("مقدم لصالح:", "شركة دانة المستقبل العقارية"),
        ("مقدم من قبل:", "مؤسسة برو لايف تكنيكال (Pro Life Technical)"),
        ("التاريخ:", "يوليو 2026"),
        ("صلاحية العرض:", "30 يوماً من تاريخ التقديم")
    ]
    
    for idx, (label, val) in enumerate(meta_info):
        row = table_meta.rows[idx]
        
        # In RTL, we want label in cell 1 and value in cell 0
        cell_lbl, cell_val = row.cells[1], row.cells[0]
        
        cell_lbl.text = ""
        p_lbl = cell_lbl.paragraphs[0]
        make_paragraph_rtl(p_lbl)
        run_lbl = p_lbl.add_run(label)
        run_lbl.bold = True
        make_run_rtl(run_lbl, "Cairo")
        run_lbl.font.color.rgb = RGBColor(22, 25, 37)
        
        cell_val.text = ""
        p_val = cell_val.paragraphs[0]
        make_paragraph_rtl(p_val)
        run_val = p_val.add_run(val)
        make_run_rtl(run_val, "Cairo")
        
        for c in [cell_lbl, cell_val]:
            set_cell_margins(c, top=80, bottom=80, left=120, right=120)
            set_cell_shading(c, "F9FAFB")
            
    doc.add_page_break()
    
    # Section 1: Project Overview
    add_header_styled(doc, "نظرة عامة على المشروع", level=1, is_arabic=True)
    p = doc.add_paragraph()
    make_paragraph_rtl(p)
    p.paragraph_format.space_after = Pt(12)
    p.paragraph_format.line_spacing = 1.15
    run = p.add_run(
        "يسر مؤسسة برو لايف تكنيكال تقديم هذا العرض لتصميم وتطوير وتدشين منصة إدارة عقارات دانة المستقبل (ERMP). "
        "تقوم المنصة بمركزية العقارات والوحدات السكنية والتجارية والمستأجرين والعقود والفواتير والمصروفات والتقارير المالية "
        "مع توفير بوابة إلكترونية تفاعلية للمستأجرين وتطبيق متكامل للويب والهواتف الذكية (iOS و Android). "
        "تم تصميم هذا النظام لمنع الأخطاء الحسابية وتدقيق المبالغ المحصلة وإلزام السداد الترتيبي للأقدم فالأحدث."
    )
    make_run_rtl(run, "Cairo")
    
    # Section 2: Business Value
    add_header_styled(doc, "القيمة المضافة للمشروع", level=1, is_arabic=True)
    business_values = [
        ("المركزية المطلقة", "مركزية العمليات والبيانات وإلغاء الاعتماد على جداول البيانات الورقية واليدوية."),
        ("أتمتة المتابعة والتذكير", "أتمتة مراقبة المتأخرات والإشعار التلقائي عبر الواتساب وسندات الدفع الفورية."),
        ("الدقة والمطابقة المالية", "تحسين دقة التحصيل وتفعيل سجل التدقيق غير القابل للتعديل للعمليات المالية والمصروفات."),
        ("السداد الترتيبي للأقدم", "توفير بوابة سداد تفاعلية تمنع المستأجرين من تخطي الشهور المتأخرة وتلزم الدفع ترتيبياً."),
        ("صناعة القرار والتقارير", "دعم الملاك بتقارير دورية مجدولة وإدارة الأدوار والصلاحيات للموظفين بالتفصيل.")
    ]
    for title, desc in business_values:
        p_val = doc.add_paragraph()
        make_paragraph_rtl(p_val)
        p_val.paragraph_format.left_indent = Inches(0.25)
        p_val.paragraph_format.space_after = Pt(4)
        
        bullet_run = p_val.add_run("• ")
        make_run_rtl(bullet_run, "Cairo")
        bullet_run.bold = True
        
        run_title = p_val.add_run(f"{title}: ")
        run_title.bold = True
        make_run_rtl(run_title, "Cairo")
        
        run_desc = p_val.add_run(desc)
        make_run_rtl(run_desc, "Cairo")

    # Section 3: Scope of Work (Table 1)
    add_header_styled(doc, "نطاق العمل ومكونات النظام الرئيسية", level=1, is_arabic=True)
    
    table_areas = doc.add_table(rows=1, cols=2)
    table_areas.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(table_areas, color="D1D5DB")
    
    # Arabic table mapping: features left, area right
    hdr_cells = table_areas.rows[0].cells
    hdr_cells[1].text = "المكون الأساسي"
    hdr_cells[0].text = "الميزات والخصائص الفنية"
    
    for c in hdr_cells:
        set_cell_shading(c, "161925") # Dark Slate
        set_cell_margins(c, top=100, bottom=100, left=120, right=120)
        p_hdr = c.paragraphs[0]
        make_paragraph_rtl(p_hdr)
        p_hdr.runs[0].bold = True
        p_hdr.runs[0].font.color.rgb = RGBColor(255, 255, 255)
        p_hdr.runs[0].font.size = Pt(10)
        make_run_rtl(p_hdr.runs[0], "Cairo")
        
    for area, feat in areas_ar:
        row = table_areas.add_row()
        cells = row.cells
        
        cells[1].text = area
        p_area = cells[1].paragraphs[0]
        make_paragraph_rtl(p_area)
        p_area.runs[0].bold = True
        make_run_rtl(p_area.runs[0], "Cairo")
        
        cells[0].text = feat
        p_feat = cells[0].paragraphs[0]
        make_paragraph_rtl(p_feat)
        make_run_rtl(p_feat.runs[0], "Cairo")
        
        for c in cells:
            set_cell_margins(c, top=80, bottom=80, left=120, right=120)
            c.paragraphs[0].runs[0].font.size = Pt(9.5)
            
    doc.add_paragraph().paragraph_format.space_after = Pt(12)
    
    # Section 4: Implementation Phases & Hours (Table 2)
    add_header_styled(doc, "مراحل التنفيذ وجدول ساعات العمل المقدرة", level=1, is_arabic=True)
    p = doc.add_paragraph()
    make_paragraph_rtl(p)
    p.paragraph_format.space_after = Pt(8)
    run = p.add_run("يبلغ إجمالي ساعات العمل البرمجية 400 ساعة عمل معتمدة، موزعة على 6 مراحل تسليم متتالية:")
    make_run_rtl(run, "Cairo")
    
    table_phases = doc.add_table(rows=1, cols=4)
    table_phases.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(table_phases, color="D1D5DB")
    
    # Arabic RTL headers: Scope left, Hours center-left, Name center-right, Num right
    hdr_ph = table_phases.rows[0].cells
    hdr_ph[3].text = "رقم"
    hdr_ph[2].text = "مرحلة التطوير"
    hdr_ph[1].text = "الساعات"
    hdr_ph[0].text = "تفاصيل ونطاق مخرجات المرحلة"
    
    for c in hdr_ph:
        set_cell_shading(c, "161925") # Dark Slate
        set_cell_margins(c, top=100, bottom=100, left=120, right=120)
        p_hdr = c.paragraphs[0]
        make_paragraph_rtl(p_hdr)
        p_hdr.runs[0].bold = True
        p_hdr.runs[0].font.color.rgb = RGBColor(255, 255, 255)
        p_hdr.runs[0].font.size = Pt(10)
        make_run_rtl(p_hdr.runs[0], "Cairo")
        
    for phase in phases_data_ar:
        row = table_phases.add_row()
        cells = row.cells
        
        cells[3].text = str(phase["num"])
        p_num = cells[3].paragraphs[0]
        make_paragraph_rtl(p_num)
        make_run_rtl(p_num.runs[0], "Cairo")
        
        cells[2].text = phase["phase"].split(": ")[-1]
        p_ph = cells[2].paragraphs[0]
        make_paragraph_rtl(p_ph)
        p_ph.runs[0].bold = True
        make_run_rtl(p_ph.runs[0], "Cairo")
        
        cells[1].text = f"{phase['hours']} ساعة"
        p_hrs = cells[1].paragraphs[0]
        make_paragraph_rtl(p_hrs)
        make_run_rtl(p_hrs.runs[0], "Cairo")
        
        cells[0].text = phase["scope"]
        p_scope = cells[0].paragraphs[0]
        make_paragraph_rtl(p_scope)
        make_run_rtl(p_scope.runs[0], "Cairo")
        
        for c in cells:
            set_cell_margins(c, top=80, bottom=80, left=120, right=120)
            c.paragraphs[0].runs[0].font.size = Pt(9.5)
            
    doc.add_page_break()
    
    # Section 5: Commercial Investment
    add_header_styled(doc, "التكاليف المالية وتفاصيل الاستثمار", level=1, is_arabic=True)
    
    table_price = doc.add_table(rows=4, cols=2)
    table_price.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(table_price, color="CCCCCC")
    
    pricing_info = [
        ("إجمالي الجهد المالي والزمني:", "400 ساعة عمل معتمدة"),
        ("القيمة الاستثمارية لتنفيذ المشروع:", "3,000 د.ك (ثلاثة آلاف دينار كويتي لا غير)"),
        ("سعر ساعة التطوير البرمجي الموحد:", "7.500 د.ك / ساعة عمل"),
        ("فترة التسليم والتشغيل المبدئية:", "شهر واحد، تبدأ بعد توفير متطلبات الاستضافة والبيانات والربط")
    ]
    
    for idx, (lbl, val) in enumerate(pricing_info):
        row = table_price.rows[idx]
        cell_lbl, cell_val = row.cells[1], row.cells[0]
        
        cell_lbl.text = ""
        p_lbl = cell_lbl.paragraphs[0]
        make_paragraph_rtl(p_lbl)
        run_lbl = p_lbl.add_run(lbl)
        run_lbl.bold = True
        make_run_rtl(run_lbl, "Cairo")
        
        cell_val.text = ""
        p_val = cell_val.paragraphs[0]
        make_paragraph_rtl(p_val)
        run_val = p_val.add_run(val)
        make_run_rtl(run_val, "Cairo")
        if "3,000" in val:
            run_val.bold = True
            run_val.font.color.rgb = RGBColor(197, 158, 63)
            
        for c in [cell_lbl, cell_val]:
            set_cell_margins(c, top=80, bottom=80, left=120, right=120)
            set_cell_shading(c, "F9FAFB" if idx % 2 == 0 else "FFFFFF")
            
    doc.add_paragraph().paragraph_format.space_after = Pt(12)
    
    # Excluded costs
    add_header_styled(doc, "تكاليف وإجراءات تشغيلية يتحملها العميل", level=2, is_arabic=True)
    p = doc.add_paragraph()
    make_paragraph_rtl(p)
    p.paragraph_format.space_after = Pt(6)
    run = p.add_run(
        "نود التنويه إلى أن تكاليف التطوير البرمجي الحالية لا تشمل رسوم الخوادم والاشتراكات الخارجية المباشرة، "
        "حيث يتعين على العميل تسجيل هذه الخدمات باسمه وبطاقته الائتمانية بشكل مباشر، وتُدفع لمزودي الخدمة:"
    )
    make_run_rtl(run, "Cairo")
    
    exclusions = [
        "رسوم الخادم السحابي الاستضافي (VPS Server)، وشهادات الحماية SSL، وحجوزات الخوادم.",
        "عمولة المعاملات المالية لبوابة الدفع الإلكتروني MyFatoorah ورسوم فتح الحساب التجاري.",
        "تكاليف إرسال رسائل الواتساب الصادرة Meta Cloud API أو Twilio (تحتسب لكل رسالة أو جلسة).",
        "رسوم حسابات المطورين لنشر التطبيق في متجر آبل ستور وجوجل بلاي في حال تطلب النشر الفوري.",
        "رسوم وتكاليف اشتراكات نطاق الموقع (Domain Registration & Subscriptions).",
        "أي تكاليف إضافية لبوابات إرسال الرسائل القصيرة SMS أو سحابة التخزين للملفات أو مزودي البريد الإلكتروني."
    ]
    
    for desc in exclusions:
        p_bullet = doc.add_paragraph()
        make_paragraph_rtl(p_bullet)
        p_bullet.paragraph_format.left_indent = Inches(0.25)
        p_bullet.paragraph_format.space_after = Pt(4)
        
        bullet_run = p_bullet.add_run("• ")
        make_run_rtl(bullet_run, "Cairo")
        bullet_run.bold = True
        
        run_desc = p_bullet.add_run(desc)
        make_run_rtl(run_desc, "Cairo")
        
    doc.add_paragraph().paragraph_format.space_after = Pt(12)
    
    # Support & Maintenance
    add_header_styled(doc, "الصيانة والدعم الفني والضمان", level=1, is_arabic=True)
    support_items = [
        "تصحيح وحل مشاكل البرمجيات والأخطاء غير المتوقعة لنطاق العمل المعتمد مجاناً لمدة سنة كاملة من تاريخ Go-Live.",
        "تقديم استشارات تشغيلية ومتابعة تقنية أساسية للخوادم خلال السنة الأولى مجاناً بالكامل وبدون رسوم إضافية.",
        "الدعم المجاني يستثني طلب ميزات برمجية جديدة أو تغييرات جوهرية أو دفع رسوم مزودي الخدمة وتغيير سياساتهم.",
        "أي طلبات تعديل أو إضافات خارج نطاق العمل المعتمد يتم تقدير ساعات عملها وإضافتها في ملحق عرض سعر منفصل."
    ]
    for desc in support_items:
        p_sup = doc.add_paragraph()
        make_paragraph_rtl(p_sup)
        p_sup.paragraph_format.left_indent = Inches(0.25)
        p_sup.paragraph_format.space_after = Pt(4)
        
        bullet_run = p_sup.add_run("• ")
        make_run_rtl(bullet_run, "Cairo")
        bullet_run.bold = True
        
        run_desc = p_sup.add_run(desc)
        make_run_rtl(run_desc, "Cairo")

    doc.add_paragraph().paragraph_format.space_after = Pt(12)

    # Terms & Assumptions
    add_header_styled(doc, "الشروط والافتراضات العامة للبدء", level=1, is_arabic=True)
    terms_items = [
        "تبدأ فترة التنفيذ (شهر واحد) فور توقيع واعتماد العرض وتوفير الوصول إلى الخوادم وبوابات الربط والبيانات المطلوبة.",
        "يرتبط الالتزام بالجدول الزمني بسرعة ردود العميل واعتماد التصاميم وتوفير حسابات بوابات الدفع وقوالب الواتساب.",
        "يتم نقل بيانات الإكسيل التاريخية القديمة يدوياً وتدقيقها ومطابقتها قبل تفعيل المنصة رسمياً للتحصيل.",
        "يتعهد العميل بتوفير الصيغ القانونية والشروط وسياسة الخصوصية والموافقة على صياغة (قيمة استثمار).",
        "تعتمد عمليات السداد المالي الرقمية على جاهزية حساب العميل لدى MyFatoorah وتنشيط طرق السداد المطلوبة.",
        "يعتبر عرض السعر الحالي صالحاً للاعتماد والتوقيع خلال فترة 30 يوماً من تاريخ التقديم."
    ]
    for desc in terms_items:
        p_term = doc.add_paragraph()
        make_paragraph_rtl(p_term)
        p_term.paragraph_format.left_indent = Inches(0.25)
        p_term.paragraph_format.space_after = Pt(4)
        
        bullet_run = p_term.add_run("• ")
        make_run_rtl(bullet_run, "Cairo")
        bullet_run.bold = True
        
        run_desc = p_term.add_run(desc)
        make_run_rtl(run_desc, "Cairo")

    doc.add_paragraph().paragraph_format.space_after = Pt(24)
    
    # Signatures
    add_header_styled(doc, "التوقيع والاعتماد الرسمي للمستند", level=1, is_arabic=True)
    p = doc.add_paragraph()
    make_paragraph_rtl(p)
    p.paragraph_format.space_after = Pt(36)
    run = p.add_run(
        "تلتزم مؤسسة برو لايف تكنيكال بتقديم حلول برمجية احترافية ذات جودة عالية ودرجة حماية وتدقيق مالي متطورة. "
        "ونحن على استعداد تام للبدء في مرحلة التحليل والتصميم الفوري بمجرد توقيع هذا المستند."
    )
    make_run_rtl(run, "Cairo")
    
    table_sig = doc.add_table(rows=3, cols=2)
    table_sig.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(table_sig, color="CCCCCC")
    
    sig_info = [
        ("اسم العميل / المفوض", "____________________________"),
        ("التوقيع والختم", "____________________________"),
        ("التاريخ", "____________________________")
    ]
    
    for idx, (lbl, val) in enumerate(sig_info):
        row = table_sig.rows[idx]
        cell_lbl, cell_val = row.cells[1], row.cells[0]
        
        cell_lbl.text = ""
        p_lbl = cell_lbl.paragraphs[0]
        make_paragraph_rtl(p_lbl)
        run_lbl = p_lbl.add_run(lbl)
        run_lbl.bold = True
        make_run_rtl(run_lbl, "Cairo")
        
        cell_val.text = ""
        p_val = cell_val.paragraphs[0]
        make_paragraph_rtl(p_val)
        run_val = p_val.add_run(val)
        make_run_rtl(run_val, "Cairo")
        
        for c in [cell_lbl, cell_val]:
            set_cell_margins(c, top=80, bottom=80, left=120, right=120)
            set_cell_shading(c, "F9FAFB" if idx % 2 == 0 else "FFFFFF")
            
    doc.save(filename)
    print(f"Generated Arabic Proposal: {filename}")


if __name__ == "__main__":
    create_english_proposal("Danat_Al_Mustaqbal_Proposal_EN.docx")
    create_arabic_proposal("Danat_Al_Mustaqbal_Proposal_AR.docx")
    print("Done! Both documents created successfully.")
