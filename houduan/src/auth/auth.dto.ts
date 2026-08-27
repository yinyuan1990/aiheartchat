import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class EnterDto {
  @IsString()
  @IsNotEmpty()
  @Length(8, 80)
  deviceId!: string;
}

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  @Length(8, 80)
  deviceId!: string;

  @IsString()
  @Length(1, 30)
  nickname!: string;

  @IsInt()
  @Min(18)
  @Max(99)
  age!: number;

  /** 1=男 2=女，注册后锁定 */
  @IsIn([1, 2])
  gender!: number;

  @IsOptional()
  @IsString()
  avatar?: string;
}
