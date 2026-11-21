import { IsUUID, IsNotEmpty, IsInt, Min } from 'class-validator';

export class ConfirmCashDto {
  @IsUUID()
  @IsNotEmpty()
  tripId: string;

  @IsUUID()
  @IsNotEmpty()
  tripPassengerId: string;

  @IsInt()
  @Min(0)
  amountCollectedPaise: number;
}
