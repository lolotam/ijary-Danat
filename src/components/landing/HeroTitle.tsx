/**
 * يعرض العنوان كاملاً مع ظهور تدريجي، ويحترم تفضيل تقليل الحركة.
 * يبقى تأثير الكتابة محصوراً في العنوان الفرعي.
 */
export function HeroTitle({ title }: { title: string }) {
  return (
    <h1 className="mb-6 text-4xl font-bold leading-[0.92] tracking-[-0.045em] text-white drop-shadow-md sm:text-6xl md:text-8xl animate-fade-in-slow motion-reduce:animate-none">
      {title}
    </h1>
  );
}
