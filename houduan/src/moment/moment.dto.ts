import { IsArray, IsIn, IsNumber, IsOptional, IsString, Length } from 'class-validator';

export class PublishMomentDto {
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  content?: string;

  /** 1=图文 2=视频 */
  @IsIn([1, 2])
  type!: number;

  @IsOptional()
  @IsArray()
  images?: string[];

  @IsOptional()
  @IsString()
  videoUrl?: string;

  @IsOptional()
  @IsString()
  coverUrl?: string;

  @IsOptional()
  @IsString()
  cityCode?: string;

  @IsOptional()
  @IsString()
  cityName?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;
}

export class CommentDto {
  @IsOptional()
  @IsString()
  @Length(0, 500)
  content?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  /** 回复的评论 id */
  @IsOptional()
  @IsString()
  replyToId?: string;
}
