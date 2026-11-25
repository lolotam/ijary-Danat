-- 15_mock_kuwait_data.sql
-- Mock data: 6 Kuwait properties, 10 units each (60 total), 40 tenants
-- with mixed Kuwait/expat nationalities.
-- Idempotent via code uniqueness. Safe to re-run.

------------------------------------------------------------------------
-- Properties (6)
------------------------------------------------------------------------
insert into public.properties (code, name_ar, name_en, type, address_ar, address_en, area, description_ar, description_en, company_id)
select v.code, v.name_ar, v.name_en, v.type::public.property_types, v.address_ar, v.address_en, v.area, v.description_ar, v.description_en, (select id from public.companies limit 1)
from (values
  ('PROP-M0001', 'برج السالمية',        'Salmiya Tower',      'tower',           'شارع سالم المبارك، السالمية',   'Salem Al Mubarak St, Salmiya',    2400.0, 'برج سكني وتجاري في قلب السالمية', 'Mixed-use residential/commercial tower in central Salmiya'),
  ('PROP-M0002', 'مجمع حولي السكني',    'Hawalli Residence',  'building_complex','شارع تونس، حولي',              'Tunis St, Hawalli',                1800.0, 'مجمع سكني عائلي',                 'Family residential complex'),
  ('PROP-M0003', 'مجمع الجابرية',       'Jabriya Court',      'compound',        'قطعة 10، الجابرية',            'Block 10, Jabriya',                3200.0, 'مجمع فلل راقٍ',                    'Premium villa compound'),
  ('PROP-M0004', 'خليج الفنطاس',        'Fintas Bay',         'tower',           'شارع الخليج العربي، الفنطاس',    'Gulf Rd, Fintas',                  2100.0, 'برج سكني بإطلالة بحرية',           'Seafront residential tower'),
  ('PROP-M0005', 'بلازا الفروانية',     'Farwaniya Plaza',    'building_complex','شارع حبيب مناور، الفروانية',    'Habib Munawwer St, Farwaniya',     2600.0, 'مجمع تجاري سكني',                  'Commercial and residential plaza'),
  ('PROP-M0006', 'مرتفعات المهبولة',    'Mahboula Heights',   'villa_compound',  'قطعة 4، المهبولة',              'Block 4, Mahboula',                4000.0, 'مجمع فلل حديث',                    'Modern villa compound')
) as v(code, name_ar, name_en, type, address_ar, address_en, area, description_ar, description_en)
on conflict (code) do nothing;

------------------------------------------------------------------------
-- Units — 10 per property, 60 total
------------------------------------------------------------------------
with p as (
  select id, code from public.properties where code like 'PROP-M000%'
),
unit_specs as (
  -- 10 unit templates applied to each property
  select * from (values
    (1,  'A101', 'apartment', 1,   85.0,  180.0),
    (2,  'A102', 'apartment', 1,   90.0,  200.0),
    (3,  'B201', 'apartment', 2,  120.0,  280.0),
    (4,  'B202', 'apartment', 2,  125.0,  290.0),
    (5,  'C301', 'apartment', 3,  160.0,  380.0),
    (6,  'C302', 'apartment', 3,  165.0,  400.0),
    (7,  'D401', 'apartment', 4,  220.0,  550.0),
    (8,  'S01',  'shop',      0,   45.0,  350.0),
    (9,  'S02',  'shop',      0,   60.0,  450.0),
    (10, 'O01',  'office',    0,   80.0,  500.0)
  ) as t(idx, suffix, utype, bedrooms, area, rent)
),
statuses as (
  select unnest(array[
    'occupied','occupied','occupied','occupied','occupied','occupied','occupied',
    'available','available','under_maintenance'
  ]::public.unit_status[]) as status,
  generate_series(1,10) as idx
)
insert into public.units (code, property_id, name, type, area, status, default_rent, description_en)
select
  p.code || '-U' || lpad(us.idx::text, 2, '0'),
  p.id,
  us.suffix,
  us.utype::public.unit_types,
  us.area,
  s.status,
  us.rent,
  case when us.bedrooms > 0 then us.bedrooms || 'BR ' || us.utype else us.utype end
from p
cross join unit_specs us
join statuses s on s.idx = us.idx
on conflict (code) do nothing;

------------------------------------------------------------------------
-- Tenants (40) — Kuwait mobiles +965 5xxxxxxx, varied nationalities
------------------------------------------------------------------------
insert into public.tenants (code, company_id, name, category, lifecycle, nationality, preferred_language, mobile, whatsapp, email, notes)
select v.code, (select id from public.companies limit 1), v.name, v.category::public.tenant_categories, v.lifecycle::public.tenant_lifecycle, v.nationality, v.lang::public.locale_code, v.mobile, v.mobile, v.email, v.notes
from (values
  ('DANA-M00001', 'أحمد سالم العتيبي',         'vip',                    'active',         'Kuwaiti',    'ar', '+96550012301', 'ahmad.otaibi@example.com',   'شركة كبرى'),
  ('DANA-M00002', 'فاطمة عبدالله المطيري',      'standard',               'active',         'Kuwaiti',    'ar', '+96550012302', 'fatima.mutairi@example.com', null),
  ('DANA-M00003', 'محمد يوسف الرشيدي',         'standard',               'active',         'Kuwaiti',    'ar', '+96550012303', 'mohd.rashidi@example.com',   null),
  ('DANA-M00004', 'نورة خالد العجمي',           'vip',                    'active',         'Kuwaiti',    'ar', '+96550012304', 'noura.ajmi@example.com',     null),
  ('DANA-M00005', 'خالد فهد الصباح',            'vip',                    'active',         'Kuwaiti',    'ar', '+96550012305', 'khalid.sabah@example.com',   null),
  ('DANA-M00006', 'Mahmoud Hassan Ibrahim',    'standard',               'active',         'Egyptian',   'ar', '+96550012306', 'mahmoud.hassan@example.com', null),
  ('DANA-M00007', 'Ahmed Kamal El-Sayed',      'standard',               'active',         'Egyptian',   'ar', '+96550012307', 'ahmed.kamal@example.com',    null),
  ('DANA-M00008', 'Sara Mostafa Farouk',       'standard',               'active',         'Egyptian',   'en', '+96550012308', 'sara.farouk@example.com',    null),
  ('DANA-M00009', 'Omar Adel Mansour',         'uncommitted',            'active',         'Egyptian',   'ar', '+96550012309', 'omar.mansour@example.com',   'Late payments'),
  ('DANA-M00010', 'Rajesh Kumar Sharma',       'standard',               'active',         'Indian',     'en', '+96550012310', 'rajesh.sharma@example.com',  null),
  ('DANA-M00011', 'Priya Venkatesh Nair',      'standard',               'active',         'Indian',     'en', '+96550012311', 'priya.nair@example.com',     null),
  ('DANA-M00012', 'Anil Krishnan Menon',       'standard',               'active',         'Indian',     'en', '+96550012312', 'anil.menon@example.com',     null),
  ('DANA-M00013', 'Deepa Ramachandran',        'vip',                    'active',         'Indian',     'en', '+96550012313', 'deepa.r@example.com',        null),
  ('DANA-M00014', 'Sunil Kumar Patel',         'standard',               'active',         'Indian',     'en', '+96550012314', 'sunil.patel@example.com',    null),
  ('DANA-M00015', 'Maria Cristina Reyes',      'standard',               'active',         'Filipino',   'en', '+96550012315', 'maria.reyes@example.com',    null),
  ('DANA-M00016', 'Jose Antonio Cruz',         'standard',               'active',         'Filipino',   'en', '+96550012316', 'jose.cruz@example.com',      null),
  ('DANA-M00017', 'Rowena Bautista Santos',    'standard',               'active',         'Filipino',   'en', '+96550012317', 'rowena.santos@example.com',  null),
  ('DANA-M00018', 'ياسر محمد الحلبي',           'standard',               'active',         'Syrian',     'ar', '+96550012318', 'yasir.halabi@example.com',   null),
  ('DANA-M00019', 'رانيا كامل الشامي',          'standard',               'active',         'Syrian',     'ar', '+96550012319', 'rania.shami@example.com',    null),
  ('DANA-M00020', 'وليد أنور الدمشقي',          'uncommitted',            'active',         'Syrian',     'ar', '+96550012320', 'waleed.dimashqi@example.com', 'Occasional delays'),
  ('DANA-M00021', 'جورج نبيل الخوري',           'vip',                    'active',         'Lebanese',   'ar', '+96550012321', 'george.khoury@example.com',  null),
  ('DANA-M00022', 'ليلى حبيب طرابلسي',          'standard',               'active',         'Lebanese',   'ar', '+96550012322', 'laila.tarabulsi@example.com',null),
  ('DANA-M00023', 'سامر إلياس عون',             'standard',               'active',         'Lebanese',   'ar', '+96550012323', 'samer.aoun@example.com',     null),
  ('DANA-M00024', 'عمر ناصر الحوراني',          'standard',               'active',         'Jordanian',  'ar', '+96550012324', 'omar.hourani@example.com',   null),
  ('DANA-M00025', 'دينا محمود العمري',          'standard',               'active',         'Jordanian',  'ar', '+96550012325', 'dina.omari@example.com',     null),
  ('DANA-M00026', 'حسام رياض الزعبي',           'standard',               'active',         'Jordanian',  'ar', '+96550012326', 'husam.zoubi@example.com',    null),
  ('DANA-M00027', 'Muhammad Imran Khan',       'standard',               'active',         'Pakistani',  'en', '+96550012327', 'imran.khan@example.com',     null),
  ('DANA-M00028', 'Ayesha Bilal Malik',        'standard',               'active',         'Pakistani',  'en', '+96550012328', 'ayesha.malik@example.com',   null),
  ('DANA-M00029', 'Zafar Ahmed Qureshi',       'chronically_distressed', 'blocked',        'Pakistani',  'en', '+96550012329', 'zafar.qureshi@example.com',  'Blocked — payment default'),
  ('DANA-M00030', 'Md Rashidul Islam',         'standard',               'active',         'Bangladeshi','en', '+96550012330', 'rashid.islam@example.com',   null),
  ('DANA-M00031', 'Farhana Akter Begum',       'standard',               'active',         'Bangladeshi','en', '+96550012331', 'farhana.begum@example.com',  null),
  ('DANA-M00032', 'Sujith Perera Fernando',    'standard',               'active',         'Sri Lankan', 'en', '+96550012332', 'sujith.fernando@example.com',null),
  ('DANA-M00033', 'Nimali Silva Dias',         'standard',               'active',         'Sri Lankan', 'en', '+96550012333', 'nimali.dias@example.com',    null),
  ('DANA-M00034', 'عبدالرحمن سعد الدوسري',      'vip',                    'active',         'Saudi',      'ar', '+96550012334', 'abdulrahman.d@example.com',  null),
  ('DANA-M00035', 'مريم فيصل القحطاني',         'standard',               'active',         'Saudi',      'ar', '+96550012335', 'mariam.qahtani@example.com', null),
  ('DANA-M00036', 'John Michael Anderson',     'standard',               'active',         'British',    'en', '+96550012336', 'john.anderson@example.com',  null),
  ('DANA-M00037', 'Emma Louise Watson',        'vip',                    'active',         'British',    'en', '+96550012337', 'emma.watson@example.com',    null),
  ('DANA-M00038', 'David Robert Miller',       'standard',               'contract_ended', 'American',   'en', '+96550012338', 'david.miller@example.com',   'Contract concluded'),
  ('DANA-M00039', 'حسن علي الحسيني',            'standard',               'active',         'Iraqi',      'ar', '+96550012339', 'hasan.husseini@example.com', null),
  ('DANA-M00040', 'زينب مهدي الكاظمي',          'standard',               'inactive',       'Iraqi',      'ar', '+96550012340', 'zainab.kadhimi@example.com', 'On hold')
) as v(code, name, category, lifecycle, nationality, lang, mobile, email, notes)
on conflict (code) do nothing;
