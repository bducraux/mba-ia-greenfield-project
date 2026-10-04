import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_PART_COUNT } from '../videos.constants';

export class CompletedPartDto {
  /** @example 1 */
  @IsInt()
  @Min(1)
  part_number: number;

  /**
   * The `ETag` response header of the part's PUT.
   * @example '"9b2cf535f27731c974343645a3985328"'
   */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Every part from 1 to `part_count`, exactly once. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PART_COUNT)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
