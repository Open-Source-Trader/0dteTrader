import { Module } from '@nestjs/common';
import { CredentialsModule } from '../credentials/credentials.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [CredentialsModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
