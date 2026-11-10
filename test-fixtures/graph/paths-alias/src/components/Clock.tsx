import { fmt } from '@/utils/date';
import { x } from '~utils/x';
import { y } from 'src/utils/y';
import missing from '@/nope';

export const Clock = () => `${fmt()} ${x} ${y} ${String(missing)}`;
