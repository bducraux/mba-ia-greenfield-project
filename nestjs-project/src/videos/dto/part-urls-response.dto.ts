import { ApiProperty } from '@nestjs/swagger';
import type { SignedPartUrls } from '../videos.service';

export class PartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ description: 'Presigned UploadPart URL (PUT the bytes).' })
  url: string;
}

export class PartUrlsResponseDto implements SignedPartUrls {
  @ApiProperty({
    type: [PartUrlDto],
    description: 'Ordered by part_number.',
  })
  parts: PartUrlDto[];

  @ApiProperty({ format: 'date-time' })
  expires_at: string;
}
