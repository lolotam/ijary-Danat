-- 11_mock_data.sql
-- Seed the database with realistic mock data for all tables.
-- Safe to re-run (ON CONFLICT DO NOTHING).
-- NOTE: Column names match the ACTUAL DB schema (not the types file).

DO $$
DECLARE
  v_company_id uuid;
  v_prop1_id uuid := '11111111-1111-1111-1111-111111111111';
  v_prop2_id uuid := '22222222-2222-2222-2222-222222222222';
  v_bcat_res_id uuid;
  v_bcat_com_id uuid;
  v_build1_id uuid := '33333333-3333-3333-3333-333333333333';
  v_build2_id uuid := '44444444-4444-4444-4444-444444444444';
  v_unit1_id uuid := '55555555-5555-5555-5555-555555555555';
  v_unit2_id uuid := '66666666-6666-6666-6666-666666666666';
  v_unit3_id uuid := '77777777-7777-7777-7777-777777777777';
  v_unit4_id uuid := '88888888-8888-8888-8888-888888888888';
  v_tenant1_id uuid := '99999999-9999-9999-9999-999999999999';
  v_tenant2_id uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_contract1_id uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  v_contract2_id uuid := 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  v_exp_cat1_id uuid;
  v_exp_cat2_id uuid;
  v_tariff_id uuid;
  v_meter1_id uuid := 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  v_reading1_id uuid := 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
BEGIN
  -- Company
  SELECT id INTO v_company_id FROM public.companies LIMIT 1;
  IF v_company_id IS NULL THEN
    v_company_id := gen_random_uuid();
    INSERT INTO public.companies (id, name_ar, name_en, email, phone)
    VALUES (v_company_id, E'\u062F\u0627\u0646\u0629 \u0627\u0644\u0645\u0633\u062A\u0642\u0628\u0644 \u0627\u0644\u0639\u0642\u0627\u0631\u064A\u0629', 'Danat Al Mustaqbal Real Estate', 'info@example.com', '+965-0000-0000');
  END IF;

  -- Building Categories
  INSERT INTO public.building_categories (code, name_ar, name_en, is_system)
  VALUES ('residential', E'\u0633\u0643\u0646\u064A', 'Residential', true) ON CONFLICT (code) DO NOTHING;
  INSERT INTO public.building_categories (code, name_ar, name_en, is_system)
  VALUES ('offices', E'\u0645\u0643\u0627\u062A\u0628', 'Offices', true) ON CONFLICT (code) DO NOTHING;
  SELECT id INTO v_bcat_res_id FROM public.building_categories WHERE code = 'residential' LIMIT 1;
  SELECT id INTO v_bcat_com_id FROM public.building_categories WHERE code = 'offices' LIMIT 1;

  -- Properties (uses location_url, not map_url)
  INSERT INTO public.properties (id, company_id, name_ar, name_en, type, location_url)
  VALUES (v_prop1_id, v_company_id, E'\u0645\u062C\u0645\u0639 \u0627\u0644\u062C\u0627\u0628\u0631\u064A\u0629 \u0627\u0644\u0633\u0643\u0646\u064A', 'Jabriya Residential Compound', 'compound', 'https://maps.google.com/?q=Jabriya')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.properties (id, company_id, name_ar, name_en, type, location_url)
  VALUES (v_prop2_id, v_company_id, E'\u0628\u0631\u062C \u0627\u0644\u0645\u0633\u062A\u0642\u0628\u0644 \u0627\u0644\u062A\u062C\u0627\u0631\u064A', 'Mustaqbal Commercial Tower', 'tower', 'https://maps.google.com/?q=Salmiya')
  ON CONFLICT (id) DO NOTHING;

  -- Buildings
  INSERT INTO public.buildings (id, property_id, name_ar, name_en, category_id)
  VALUES (v_build1_id, v_prop1_id, E'\u0645\u0628\u0646\u0649 \u0623', 'Building A', v_bcat_res_id) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.buildings (id, property_id, name_ar, name_en, category_id)
  VALUES (v_build2_id, v_prop2_id, E'\u0627\u0644\u0628\u0631\u062C \u0627\u0644\u0631\u0626\u064A\u0633\u064A', 'Main Tower', v_bcat_com_id) ON CONFLICT (id) DO NOTHING;

  -- Units: uses "name" (not name_ar/name_en), requires property_id, no floor column
  -- electricity_meter_ownership enum: 'company_owned' | 'tenant_owned'
  INSERT INTO public.units (id, building_id, property_id, name, type, area, default_rent, electricity_meter_ownership)
  VALUES
    (v_unit1_id, v_build1_id, v_prop1_id, E'\u0634\u0642\u0629 101', 'apartment', 120.00, 450.000, 'company_owned'),
    (v_unit2_id, v_build1_id, v_prop1_id, E'\u0634\u0642\u0629 102', 'apartment', 120.00, 450.000, 'tenant_owned'),
    (v_unit3_id, v_build2_id, v_prop2_id, E'\u0645\u0643\u062A\u0628 201', 'office', 200.00, 950.000, 'company_owned'),
    (v_unit4_id, v_build2_id, v_prop2_id, E'\u0645\u0643\u062A\u0628 202', 'office', 180.00, 850.000, 'company_owned')
  ON CONFLICT (id) DO NOTHING;

  -- Tenants: uses "name", "mobile", "preferred_language" (no civil_id, no phone, no preferred_locale)
  INSERT INTO public.tenants (id, company_id, name, mobile, email, preferred_language, tenant_portal_enabled)
  VALUES
    (v_tenant1_id, v_company_id, E'\u0623\u062D\u0645\u062F \u0627\u0644\u0639\u062A\u064A\u0628\u064A', '+965-9999-1111', 'ahmad@example.com', 'ar', true),
    (v_tenant2_id, v_company_id, E'\u0634\u0631\u0643\u0629 \u0627\u0644\u062A\u0643\u0646\u0648\u0644\u0648\u062C\u064A\u0627 \u0627\u0644\u0645\u062A\u0642\u062F\u0645\u0629', '+965-2222-3333', 'info@advtech.com', 'en', true)
  ON CONFLICT (id) DO NOTHING;

  -- Contracts: monthly_amount (not monthly_rent), grace_days (not grace_period_days),
  -- state (not status), type required, due_day required
  INSERT INTO public.contracts (id, tenant_id, unit_id, type, state, start_date, end_date, monthly_amount, due_day, grace_days)
  VALUES
    (v_contract1_id, v_tenant1_id, v_unit1_id, 'investment', 'active', '2026-01-01', '2026-12-31', 450.000, 1, 5),
    (v_contract2_id, v_tenant2_id, v_unit3_id, 'investment', 'active', '2026-01-01', '2027-12-31', 950.000, 1, 10)
  ON CONFLICT (id) DO NOTHING;

  -- Expense Categories (no company_id column)
  INSERT INTO public.expense_categories (code, name_ar, name_en)
  VALUES ('elev-maint', E'\u0635\u064A\u0627\u0646\u0629 \u0645\u0635\u0639\u062F', 'Elevator Maintenance')
  ON CONFLICT (code) DO NOTHING;
  INSERT INTO public.expense_categories (code, name_ar, name_en)
  VALUES ('cleaning', E'\u062A\u0646\u0638\u064A\u0641 \u0648\u062D\u0631\u0627\u0633\u0629', 'Cleaning & Security')
  ON CONFLICT (code) DO NOTHING;
  SELECT id INTO v_exp_cat1_id FROM public.expense_categories WHERE code = 'elev-maint' LIMIT 1;
  SELECT id INTO v_exp_cat2_id FROM public.expense_categories WHERE code = 'cleaning' LIMIT 1;

  -- Expenses: class enum ('contractual_monthly','contractual_annual','regular_recurring','sudden_one_time')
  -- has note (not description_ar/en), currency, payee
  INSERT INTO public.expenses (company_id, category_id, unit_id, amount, currency, expense_date, note, class)
  VALUES (v_company_id, v_exp_cat1_id, v_unit1_id, 120.000, 'KWD', '2026-05-10', 'Elevator repair on first floor', 'sudden_one_time')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.expenses (company_id, category_id, amount, currency, expense_date, note, class)
  VALUES (v_company_id, v_exp_cat2_id, 300.000, 'KWD', '2026-06-01', 'Monthly compound cleaning contract', 'regular_recurring')
  ON CONFLICT (id) DO NOTHING;

  -- Deposits: status enum ('pending','confirmed','cancelled'), has currency, note (no reference_number)
  INSERT INTO public.deposits (company_id, bank_name, amount, currency, deposit_date, note, status)
  VALUES (v_company_id, E'\u0628\u0646\u0643 \u0627\u0644\u0643\u0648\u064A\u062A \u0627\u0644\u0648\u0637\u0646\u064A', 2500.000, 'KWD', '2026-06-15', 'DEP-NBK-9876', 'confirmed')
  ON CONFLICT (id) DO NOTHING;

  -- Electricity Tariffs: unit_price (not rate_per_kwh), no company_id, type enum
  INSERT INTO public.electricity_tariffs (code, name_ar, name_en, type, unit_price)
  VALUES ('res-tariff', E'\u062A\u0639\u0631\u064A\u0641\u0629 \u0633\u0643\u0646\u064A\u0629', 'Residential Tariff', 'flat', 0.002)
  ON CONFLICT (code) DO NOTHING;
  SELECT id INTO v_tariff_id FROM public.electricity_tariffs WHERE code = 'res-tariff' LIMIT 1;

  -- Electricity Meters: ownership (not electricity_meter_ownership), is_active
  INSERT INTO public.electricity_meters (id, unit_id, meter_number, tariff_id, ownership, is_active)
  VALUES (v_meter1_id, v_unit2_id, 'ELEC-MTR-9988', v_tariff_id, 'company_owned', true)
  ON CONFLICT (id) DO NOTHING;

  -- Meter Readings: reading (not reading_value), period_year, period_month
  INSERT INTO public.meter_readings (id, meter_id, reading, reading_date, period_year, period_month)
  VALUES (v_reading1_id, v_meter1_id, 12500.00, '2026-06-30', 2026, 6)
  ON CONFLICT (id) DO NOTHING;

  -- Generate invoices for mock contracts
  PERFORM public.generate_invoices(NULL, 2026);

  -- Evaluate overdue invoices
  PERFORM public.evaluate_overdue('2026-07-15');
END $$;
