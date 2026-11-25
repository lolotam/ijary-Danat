/** Lucide icon by kebab-case name (loads lucide UMD from CDN; same glyph set as the product's lucide-react). */
export interface IconProps {
  /** kebab-case lucide name, e.g. "building-2", "file-text", "credit-card" */
  name: string;
  /** px, default 16 */
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}
export declare function Icon(props: IconProps): JSX.Element;
