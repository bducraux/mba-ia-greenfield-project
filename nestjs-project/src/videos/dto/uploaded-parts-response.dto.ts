import { ApiProperty } from '@nestjs/swagger';
import type { UploadedParts } from '../videos.service';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  etag: string;

  @ApiProperty({ example: 67108864 })
  size: number;
}

export class UploadedPartsResponseDto implements UploadedParts {
  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 1 })
  part_count: number;

  @ApiProperty({
    type: [UploadedPartDto],
    description: 'Parts storage already holds, ordered by part_number.',
  })
  parts: UploadedPartDto[];
}
