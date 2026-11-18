import { IsNotEmpty, IsString, IsUUID, Length, Matches } from 'class-validator';

export class VerifyBoardingDto {
  @IsUUID('4', { message: 'passengerId must be a valid UUID' })
  @IsNotEmpty()
  passengerId!: string;

  @IsString()
  @IsNotEmpty()
  @Length(4, 4, { message: 'OTP must be exactly 4 digits' })
  @Matches(/^\d{4}$/, { message: 'OTP must consist of numeric digits only' })
  otp!: string;
}
