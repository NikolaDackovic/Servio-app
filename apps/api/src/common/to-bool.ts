import { Transform } from 'class-transformer';

/** Query parametar "true"/"false" → boolean. (@Type(() => Boolean) bi "false" pretvorio u true.) */
export const ToBool = () => Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value));
