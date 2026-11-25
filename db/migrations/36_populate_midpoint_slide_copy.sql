-- 36_populate_midpoint_slide_copy.sql
-- Fill missing copy for up to 20 midpoint slides without replacing staff-authored text.

with ranked_slides as (
  select
    id,
    row_number() over (
      partition by company_id, carousel_key
      order by display_order, created_at, id
    ) as slide_number
  from public.landing_carousel_slides
  where carousel_key = 'main_midpoint'
), slide_messages as (
  select *
  from (values
    (1, 'وجهة عصرية في قلب الجهراء', 'A Modern Landmark in the Heart of Jahra', 'استمتع بوجهة تجمع التسوق والخدمات والأجواء اليومية في موقع واحد.', 'Discover a destination that brings together shopping, services, and everyday experiences in one place.', 'اكتشف المجمع', 'Discover the complex', '#shops'),
    (2, 'تسوق يواكب يومك', 'Shopping That Fits Your Day', 'من احتياجاتك اليومية إلى اختياراتك المفضلة، كل ما تحتاجه قريب منك.', 'From daily essentials to your favourite finds, everything you need is close by.', 'استكشف المحلات', 'Explore stores', '#shops'),
    (3, 'نكهات تستحق الزيارة', 'Flavours Worth Visiting For', 'مطاعم ومقاهٍ تمنح كل زيارة طعماً جديداً ولحظة أجمل.', 'Restaurants and cafes that give every visit a new flavour and a better moment.', 'اكتشف المطاعم', 'Discover dining', '#shops'),
    (4, 'قهوة تليق بلحظتك', 'Coffee for Every Moment', 'خذ استراحة قصيرة، التَقِ بالأصدقاء، واستمتع بأجواء المقاهي المفضلة لديك.', 'Take a break, meet friends, and enjoy the atmosphere of your favourite cafes.', 'ابحث عن مقهى', 'Find a cafe', '#shops'),
    (5, 'خدمات قريبة منك', 'Services Close to You', 'خدمات عملية تجعل تفاصيل يومك أسهل وأكثر راحة.', 'Convenient services that make the details of your day easier and more comfortable.', 'استكشف الخدمات', 'Explore services', '#shops'),
    (6, 'وجهة للعائلة', 'A Destination for Families', 'مساحات مريحة وخيارات متنوعة تناسب جميع أفراد العائلة.', 'Comfortable spaces and varied choices for every member of the family.', 'خطط لزيارتك', 'Plan your visit', '#location'),
    (7, 'وقت للعافية', 'Time for Wellness', 'خيارات الصحة والجمال واللياقة في مكان واحد قريب منك.', 'Health, beauty, and fitness choices in one convenient destination.', 'اكتشف العافية', 'Discover wellness', '#facilities'),
    (8, 'أناقة لكل مناسبة', 'Style for Every Occasion', 'اكتشف علامات وخيارات تساعدك على إكمال إطلالتك بثقة.', 'Discover brands and choices that help you complete every look with confidence.', 'تسوّق الآن', 'Shop now', '#shops'),
    (9, 'موقع سهل الوصول', 'Easy to Reach', 'موقع استراتيجي يضع وجهتك اليومية ضمن خطواتك المعتادة.', 'A strategic location that keeps your daily destination within your usual route.', 'اعرض الموقع', 'View location', '#location'),
    (10, 'أكثر من مجرد تسوق', 'More Than Shopping', 'مكان تلتقي فيه الأعمال والترفيه والخدمات في تجربة متكاملة.', 'A place where business, leisure, and services meet in one complete experience.', 'اكتشف المزيد', 'Discover more', '#shops'),
    (11, 'خيارات تتجدد دائماً', 'Always Something New', 'عد إلينا دائماً لاكتشاف وجهات وتجارب تناسب اهتماماتك.', 'Come back to discover destinations and experiences that match your interests.', 'استكشف الجديد', 'Explore what is new', '#shops'),
    (12, 'مكانك للاجتماع', 'Your Place to Meet', 'موعد عمل سريع أو لقاء ودّي، تجد المساحة المناسبة هنا.', 'For a quick business meeting or a friendly catch-up, find the right space here.', 'خطط للقاءك', 'Plan your visit', '#location'),
    (13, 'راحة في كل زيارة', 'Comfort in Every Visit', 'مواقف وخدمات ومساحات مصممة لتجعل زيارتك أسهل.', 'Parking, services, and spaces designed to make every visit easier.', 'اعرف المزيد', 'Learn more', '#facilities'),
    (14, 'علامات تعرفها وتحبها', 'Brands You Know and Love', 'تعرّف على مجموعة متنوعة من العلامات والخدمات تحت سقف واحد.', 'Explore a diverse collection of brands and services under one roof.', 'عرض الدليل', 'View directory', '#shops'),
    (15, 'كل يوم له تجربة جديدة', 'A New Experience Every Day', 'اجعل زيارتك جزءاً من يومك مع خيارات تناسب كل وقت.', 'Make every visit part of your day with choices for every moment.', 'استكشف الوجهة', 'Explore the destination', '#shops'),
    (16, 'مساحات للأعمال والطموح', 'Space for Business and Ambition', 'وجهة تجارية تمنح الأعمال موقعاً واضحاً وحضوراً أقوى.', 'A commercial destination that gives businesses a visible location and stronger presence.', 'تواصل معنا', 'Contact us', '#leasing'),
    (17, 'فرصتك تبدأ من هنا', 'Your Opportunity Starts Here', 'ابحث عن مساحة تجارية تناسب فكرتك وخطوتك التالية.', 'Find a commercial space that fits your idea and your next step.', 'استفسر عن التأجير', 'Ask about leasing', '#leasing'),
    (18, 'تجربة محلية بطابع مميز', 'A Distinctly Local Experience', 'وجهات مختارة بعناية تعكس احتياجات المجتمع وروحه.', 'Carefully selected destinations that reflect the community and its spirit.', 'تعرف علينا', 'Get to know us', '#about'),
    (19, 'كل ما تحتاجه في مكان واحد', 'Everything You Need in One Place', 'وفر وقتك واستمتع بخيارات يومية قريبة وسهلة.', 'Save time and enjoy convenient daily choices close to you.', 'ابدأ الاستكشاف', 'Start exploring', '#shops'),
    (20, 'نلتقي على تجربة أفضل', 'Meet Us for a Better Experience', 'نتطلع لاستقبالك في وجهتك اليومية الجديدة في الجهراء.', 'We look forward to welcoming you to your new daily destination in Jahra.', 'زورنا اليوم', 'Visit us today', '#location')
  ) as messages(slide_number, title_ar, title_en, description_ar, description_en, cta_label_ar, cta_label_en, cta_url)
)
update public.landing_carousel_slides as slides
set
  title_ar = case when nullif(trim(slides.title_ar), '') is null or slides.title_ar = 'شريحة جديدة' then messages.title_ar else slides.title_ar end,
  title_en = case when nullif(trim(slides.title_en), '') is null or slides.title_en = 'New slide' then messages.title_en else slides.title_en end,
  description_ar = coalesce(nullif(trim(slides.description_ar), ''), messages.description_ar),
  description_en = coalesce(nullif(trim(slides.description_en), ''), messages.description_en),
  cta_label_ar = coalesce(nullif(trim(slides.cta_label_ar), ''), messages.cta_label_ar),
  cta_label_en = coalesce(nullif(trim(slides.cta_label_en), ''), messages.cta_label_en),
  cta_url = coalesce(nullif(trim(slides.cta_url), ''), messages.cta_url)
from ranked_slides
join slide_messages as messages on messages.slide_number = ranked_slides.slide_number
where slides.id = ranked_slides.id;
