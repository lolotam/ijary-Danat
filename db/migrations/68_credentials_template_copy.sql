-- 68_credentials_template_copy.sql
--
-- The credentials templates seeded by migration 32 spell the credentials out
-- inline:
--
--   "مرحباً {{display_name}}، بيانات الدخول: {{username}} / {{password}}"
--
-- That was correct while nothing rendered them. The automatic credentials mail
-- ignored these rows entirely and used hardcoded HTML from
-- src/lib/emailTemplates.ts, so editing a template in Settings changed nothing.
--
-- notifyUserCredentials now renders the body as the *intro* of the branded
-- mail, above a credentials box that code builds from the five fields
-- (name, username, password, email, WhatsApp). Leaving the old text in place
-- would print the username and password twice — once as prose, once in the box.
--
-- So the bodies become an opening only. Everything the recipient needs to sign
-- in comes from the box, which an edit here cannot break.
--
-- One row per locale serves BOTH a managerial account and a tenant portal
-- account (`unique (type, channel, locale)`), so the copy stays neutral about
-- which kind of account was created.

update public.notification_templates
set
  subject_ar = 'بيانات الدخول — {{display_name}}',
  subject_en = 'Login credentials — {{display_name}}',
  body_ar =
    '<p>مرحباً {{display_name}}،</p>' ||
    '<p>تم إنشاء حسابك بنجاح. تجد بيانات الدخول الخاصة بك أدناه، ' ||
    'ونوصي بتغيير كلمة المرور فور تسجيل الدخول لأول مرة.</p>',
  body_en =
    '<p>Hello {{display_name}},</p>' ||
    '<p>Your account has been created. Your sign-in details are below — ' ||
    'please change the password as soon as you first sign in.</p>'
where code in ('user-credentials-ar', 'user-credentials-en');

-- Available placeholders, for whoever edits these next:
--
--   {{display_name}}  the account holder's name
--   {{username}}      the sign-in username
--   {{password}}      the generated password
--   {{email}}         the sign-in email address
--   {{mobile}}        the WhatsApp / mobile number, blank when none is on file
--   {{login_url}}     /auth for managerial accounts, /portal for tenants
--
-- Values are HTML-escaped before substitution; the surrounding markup here is
-- not, so this body may legitimately contain tags. An unknown placeholder is
-- left verbatim in the sent message rather than blanked, so a typo is visible.
