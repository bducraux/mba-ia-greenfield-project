import { ApiProperty } from '@nestjs/swagger';
import type { InitiateUploadResult } from '../videos.service';
import { VideoResponseDto } from './video-response.dto';

export class UploadSessionDto {
  @ApiProperty({
    description: 'Clients slice the file at exactly this size.',
    example: 67108864,
  })
  part_size: number;

  @ApiProperty({ description: 'ceil(size / part_size)', example: 1 })
  part_count: number;
}

export class InitiateUploadResponseDto implements InitiateUploadResult {
  @ApiProperty({ type: VideoResponseDto })
  video: VideoResponseDto;

  @ApiProperty({ type: UploadSessionDto })
  upload: UploadSessionDto;
}
