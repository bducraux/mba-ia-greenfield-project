import { ApiProperty } from '@nestjs/swagger';
import type { MediaUrl } from '../videos.service';

export class MediaUrlResponseDto implements MediaUrl {
  @ApiProperty({ description: 'Presigned GET URL served by storage.' })
  url: string;

  @ApiProperty({ format: 'date-time' })
  expires_at: string;
}
