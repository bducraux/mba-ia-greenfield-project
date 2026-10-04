import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { MAX_PART_COUNT } from '../videos.constants';

export class SignPartUrlsDto {
  /**
   * Part numbers to presign, each between 1 and `part_count`.
   * @example [1, 2, 3]
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PART_COUNT)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
