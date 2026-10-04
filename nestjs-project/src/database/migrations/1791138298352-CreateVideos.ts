import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1791138298352 implements MigrationInterface {
  name = 'CreateVideos1791138298352';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channel_id" uuid NOT NULL, "short_id" character varying(11) NOT NULL, "title" character varying(100) NOT NULL, "description" text, "processing_status" character varying(20) NOT NULL DEFAULT 'uploading', "publication_status" character varying(20) NOT NULL DEFAULT 'draft', "failure_reason" character varying(32), "original_object_key" character varying(255) NOT NULL, "mime_type" character varying(64) NOT NULL, "size_bytes" bigint NOT NULL, "upload_id" text NOT NULL, "duration_seconds" double precision, "width" integer, "height" integer, "video_codec" character varying(32), "audio_codec" character varying(32), "thumbnail_object_key" character varying(255), "processed_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_19730351bdef490001171fffe3e" UNIQUE ("short_id"), CONSTRAINT "CHK_videos_failure_reason" CHECK ("failure_reason" IN ('UNSUPPORTED_FORMAT', 'PROCESSING_FAILED', 'SOURCE_MISSING', 'UPLOAD_REJECTED')), CONSTRAINT "CHK_videos_publication_status" CHECK ("publication_status" IN ('draft')), CONSTRAINT "CHK_videos_processing_status" CHECK ("processing_status" IN ('uploading', 'processing', 'ready', 'failed')), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_023a8e4f3f1a34ff3d8ca04a4c" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_023a8e4f3f1a34ff3d8ca04a4c"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
  }
}
