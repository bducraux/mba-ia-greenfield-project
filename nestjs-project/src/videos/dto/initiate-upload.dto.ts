import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

export class InitiateUploadDto {
  /**
   * Original file name; the extension must be .mp4, .m4v or .webm. The video
   * title is the name without extension.
   * @example 'clip.mp4'
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  file_name: string;

  /**
   * `video/mp4` or `video/webm`, matching the extension.
   * @example 'video/mp4'
   */
  @IsString()
  @IsNotEmpty()
  mime_type: string;

  /**
   * File size in bytes (at most 10737418240).
   * @example 1048576
   */
  @IsInt()
  @Min(1)
  size: number;
}
