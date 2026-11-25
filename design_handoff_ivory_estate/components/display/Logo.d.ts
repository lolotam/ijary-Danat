/** Brand lockup: gold lotus mark (assets/logo.png) + bilingual name. */
export interface LogoProps {
  /** tile px, default 44 */
  size?: number;
  /** path to assets/logo.png relative to the page; omit for the د monogram fallback */
  src?: string;
  name?: string;
  subName?: string;
  showName?: boolean;
  /** true when placed on an --ink surface */
  onDark?: boolean;
}
export declare function Logo(props: LogoProps): JSX.Element;
