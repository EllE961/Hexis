/**
 * Icon — single wrapper around @vscode/codicons.
 *
 * Every icon in the app chrome goes through this component so size,
 * color, and alignment stay consistent. Codicons are the exact same
 * icon set VS Code uses, rendered from a font file, so they look
 * identical to native IDE chrome.
 *
 * Usage:
 *   <Icon name="trash" />                         // default size (W.icon)
 *   <Icon name="git-branch" color={W.textDim} />
 *   <Icon name="close" size={W.iconSm} />
 *   <Icon name="sparkle" size={W.iconMd} color={W.accent} />
 *
 * Full icon catalogue:
 *   https://microsoft.github.io/vscode-codicons/dist/codicon.html
 *
 * The font is imported once in `src/main.jsx`
 * (`import '@vscode/codicons/dist/codicon.css'`) so you never need to
 * import the CSS again from here.
 */

import { W } from '../../theme/window-tokens.js';

export function Icon({
  name,
  size = W.icon,
  color,
  style,
  className = '',
  title,
  onClick,
  ...rest
}) {
  return (
    <i
      className={`codicon codicon-${name} ${className}`.trim()}
      style={{
        fontSize: size,
        width: size,
        height: size,
        color: color || 'inherit',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        verticalAlign: 'middle',
        flexShrink: 0,
        ...style,
      }}
      title={title}
      onClick={onClick}
      aria-hidden={title ? undefined : 'true'}
      aria-label={title}
      {...rest}
    />
  );
}

export default Icon;
