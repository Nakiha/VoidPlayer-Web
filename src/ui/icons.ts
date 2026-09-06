// Phosphor's regular weight matches the compact optical-glass chrome. Import
// Plus and refresh use bold for optical balance at small sizes. Import
// only the icons we use; no icon font, CDN, or entire catalog enters the bundle.
import eye from '@phosphor-icons/core/assets/regular/eye.svg?raw';
import eyeClosed from '@phosphor-icons/core/assets/regular/eye-slash.svg?raw';
import sidebar from '@phosphor-icons/core/assets/regular/sidebar-simple.svg?raw';
import rows from '@phosphor-icons/core/assets/regular/rows.svg?raw';
import filePlus from '@phosphor-icons/core/assets/regular/file-plus.svg?raw';
import open from '@phosphor-icons/core/assets/regular/folder-open.svg?raw';
import share from '@phosphor-icons/core/assets/regular/export.svg?raw';
import play from '@phosphor-icons/core/assets/regular/play.svg?raw';
import pause from '@phosphor-icons/core/assets/regular/pause.svg?raw';
import previous from '@phosphor-icons/core/assets/regular/skip-back.svg?raw';
import next from '@phosphor-icons/core/assets/regular/skip-forward.svg?raw';
import plus from '@phosphor-icons/core/assets/bold/plus-bold.svg?raw';
import close from '@phosphor-icons/core/assets/regular/x.svg?raw';
import more from '@phosphor-icons/core/assets/regular/dots-three.svg?raw';
import note from '@phosphor-icons/core/assets/regular/note-pencil.svg?raw';
import refresh from '@phosphor-icons/core/assets/bold/arrow-clockwise-bold.svg?raw';
import search from '@phosphor-icons/core/assets/regular/magnifying-glass.svg?raw';
import down from '@phosphor-icons/core/assets/regular/caret-down.svg?raw';
import film from '@phosphor-icons/core/assets/regular/film-strip.svg?raw';
import fit from '@phosphor-icons/core/assets/regular/arrows-out.svg?raw';
import marker from '@phosphor-icons/core/assets/regular/diamond.svg?raw';

import grip from '@phosphor-icons/core/assets/regular/dots-six-vertical.svg?raw';
import copy from '@phosphor-icons/core/assets/regular/copy.svg?raw';
import download from '@phosphor-icons/core/assets/regular/download-simple.svg?raw';

import center from '@phosphor-icons/core/assets/regular/crosshair.svg?raw';

import pen from '@phosphor-icons/core/assets/regular/pencil-simple.svg?raw';
import ellipse from '@phosphor-icons/core/assets/regular/circle.svg?raw';
import rect from '@phosphor-icons/core/assets/regular/rectangle.svg?raw';
import line from '@phosphor-icons/core/assets/regular/line-segment.svg?raw';
import lettering from '@phosphor-icons/core/assets/regular/text-t.svg?raw';
import undo from '@phosphor-icons/core/assets/regular/arrow-counter-clockwise.svg?raw';

import grid from '@phosphor-icons/core/assets/regular/squares-four.svg?raw';
import columns from '@phosphor-icons/core/assets/regular/columns.svg?raw';

import select from '@phosphor-icons/core/assets/regular/cursor.svg?raw';
import eraser from '@phosphor-icons/core/assets/regular/eraser.svg?raw';
import redo from '@phosphor-icons/core/assets/regular/arrow-clockwise.svg?raw';
import trash from '@phosphor-icons/core/assets/regular/trash.svg?raw';
const icons = { select, eraser, redo, trash, filePlus, eye, eyeClosed, grid, columns, pen, ellipse, rect, line, text: lettering, undo, center, grip, copy, download, sidebar, rows, open, export: share, play, pause, previous, next, plus, close, more, note, refresh, search, down, film, fit, marker };
export function icon(name: keyof typeof icons, extraClass = '') {
  return icons[name].replace('<svg ', `<svg class="icon ${extraClass}" data-icon="${name}" aria-hidden="true" focusable="false" `);
}
