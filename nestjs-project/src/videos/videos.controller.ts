import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { MediaUrlResponseDto } from './dto/media-url-response.dto';
import { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import { SignPartUrlsDto } from './dto/sign-part-urls.dto';
import { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

/** Error response documented with the shared envelope. */
function ApiError(status: number, description: string): MethodDecorator {
  return ApiResponse({
    status,
    description,
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  });
}

const ApiShortIdParam = (): MethodDecorator =>
  ApiParam({
    name: 'shortId',
    description:
      "The video's 11-char short id. Malformed, unknown and not-owned ids all respond 404.",
    example: 'dQw4w9WgXcQ',
  });

@ApiTags('videos')
@ApiBearerAuth('access-token')
@SkipThrottle()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Creates the video as an `uploading` draft and opens a multipart upload in storage. The client then slices the file at `part_size` and requests presigned part URLs.',
  })
  @ApiBody({ type: InitiateUploadDto })
  @ApiResponse({
    status: 201,
    description: 'Draft created and upload session opened',
    type: InitiateUploadResponseDto,
  })
  @ApiError(400, 'Validation failed')
  @ApiError(401, 'Missing or invalid access token')
  @ApiError(
    415,
    'UNSUPPORTED_VIDEO_FORMAT: mime type or extension outside the allowlist, or mismatched',
  )
  @ApiError(422, 'VIDEO_TOO_LARGE: size above 10 GiB')
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':shortId/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Presign part upload URLs',
    description:
      'Returns presigned `UploadPart` URLs (1 h TTL) for the requested parts. Callable again at any time while the upload is in progress, e.g. to re-sign expired URLs.',
  })
  @ApiShortIdParam()
  @ApiBody({ type: SignPartUrlsDto })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    type: PartUrlsResponseDto,
  })
  @ApiError(400, 'Validation failed')
  @ApiError(401, 'Missing or invalid access token')
  @ApiError(404, 'VIDEO_NOT_FOUND')
  @ApiError(409, 'UPLOAD_NOT_IN_PROGRESS: the video is no longer uploading')
  @ApiError(422, 'INVALID_UPLOAD_PARTS: a part number is above part_count')
  async signPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('shortId') shortId: string,
    @Body() dto: SignPartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    return this.videosService.signPartUrls(user.sub, shortId, dto.part_numbers);
  }

  @Get(':shortId/upload/parts')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Lists the parts storage already holds, so a client resuming the upload sends only the missing ones.',
  })
  @ApiShortIdParam()
  @ApiResponse({
    status: 200,
    description: 'Parts already uploaded',
    type: UploadedPartsResponseDto,
  })
  @ApiError(401, 'Missing or invalid access token')
  @ApiError(404, 'VIDEO_NOT_FOUND')
  @ApiError(409, 'UPLOAD_NOT_IN_PROGRESS: the video is no longer uploading')
  @ApiError(
    410,
    'UPLOAD_SESSION_EXPIRED: the multipart upload was aborted by storage',
  )
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('shortId') shortId: string,
  ): Promise<UploadedPartsResponseDto> {
    return this.videosService.listUploadedParts(user.sub, shortId);
  }

  @Post(':shortId/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete the upload',
    description:
      'Assembles the parts, checks the final size, enqueues processing and moves the video to `processing`. Idempotent: replaying it on a `processing` or `ready` video returns the current state.',
  })
  @ApiShortIdParam()
  @ApiBody({ type: CompleteUploadDto })
  @ApiResponse({
    status: 200,
    description: 'Video queued for processing (or its current state on replay)',
    type: VideoResponseDto,
  })
  @ApiError(400, 'Validation failed')
  @ApiError(401, 'Missing or invalid access token')
  @ApiError(404, 'VIDEO_NOT_FOUND')
  @ApiError(409, 'UPLOAD_NOT_IN_PROGRESS: the video has failed')
  @ApiError(
    410,
    'UPLOAD_SESSION_EXPIRED: the multipart upload is gone and no assembled object exists',
  )
  @ApiError(
    422,
    'INVALID_UPLOAD_PARTS, VIDEO_TOO_LARGE or VIDEO_SIZE_MISMATCH (the last two mark the video failed)',
  )
  @ApiError(
    503,
    'PROCESSING_QUEUE_UNAVAILABLE: the video stays uploading; retrying is safe',
  )
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('shortId') shortId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<VideoResponseDto> {
    return this.videosService.completeUpload(user.sub, shortId, dto.parts);
  }

  @Get(':shortId')
  @ApiOperation({
    summary: 'Get a video',
    description:
      'Owner view of the video. Poll it to follow processing (`processing_status`, `failure_reason`, `thumbnail_url`).',
  })
  @ApiShortIdParam()
  @ApiResponse({
    status: 200,
    description: 'The video',
    type: VideoResponseDto,
  })
  @ApiError(401, 'Missing or invalid access token')
  @ApiError(404, 'VIDEO_NOT_FOUND')
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('shortId') shortId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.findOwnedByShortId(
      user.sub,
      shortId,
    );
    return this.videosService.toResponse(video);
  }

  @Get(':shortId/playback-url')
  @ApiOperation({
    summary: 'Get a streaming URL',
    description:
      'Presigned URL (4 h TTL) for `<video src>`; storage serves HTTP Range requests natively. Only for `ready` videos.',
  })
  @ApiShortIdParam()
  @ApiResponse({
    status: 200,
    description: 'Presigned streaming URL',
    type: MediaUrlResponseDto,
  })
  @ApiError(401, 'Missing or invalid access token')
  @ApiError(404, 'VIDEO_NOT_FOUND')
  @ApiError(409, 'VIDEO_NOT_READY: the video has not finished processing')
  async getPlaybackUrl(
    @CurrentUser() user: JwtPayload,
    @Param('shortId') shortId: string,
  ): Promise<MediaUrlResponseDto> {
    return this.videosService.getPlaybackUrl(user.sub, shortId);
  }

  @Get(':shortId/download-url')
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Presigned URL (1 h TTL) whose response forces a download (`Content-Disposition: attachment`, named after the title). Only for `ready` videos.',
  })
  @ApiShortIdParam()
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    type: MediaUrlResponseDto,
  })
  @ApiError(401, 'Missing or invalid access token')
  @ApiError(404, 'VIDEO_NOT_FOUND')
  @ApiError(409, 'VIDEO_NOT_READY: the video has not finished processing')
  async getDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('shortId') shortId: string,
  ): Promise<MediaUrlResponseDto> {
    return this.videosService.getDownloadUrl(user.sub, shortId);
  }
}
