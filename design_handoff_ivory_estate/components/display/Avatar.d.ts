/** Circular avatar with initials fallback. */
export interface AvatarProps {
  src?: string;
  fallback?: string;
  size?: number;
  className?: string;
}
export declare function Avatar(props: AvatarProps): JSX.Element;
