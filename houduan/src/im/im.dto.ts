import { IsArray, IsOptional, IsString, Length } from 'class-validator';

export class CreateGroupDto {
  @IsString()
  @Length(1, 50)
  name!: string;

  @IsOptional()
  @IsArray()
  memberIds?: string[];

  @IsOptional()
  @IsString()
  avatar?: string;
}

export class MemberIdsDto {
  @IsArray()
  userIds!: string[];
}

export class GroupInfoDto {
  @IsOptional()
  @IsString()
  @Length(1, 50)
  name?: string;

  @IsOptional()
  @IsString()
  avatar?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  notice?: string;
}
