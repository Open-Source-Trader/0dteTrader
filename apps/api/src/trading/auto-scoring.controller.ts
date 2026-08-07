import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import type {
  AutoScoringPreferenceCreate,
  AutoScoringPreferenceRecord,
  AutoScoringPreferenceUpdate,
  AutoScoringResult,
} from '@0dtetrader/shared-types';
import { AuthenticatedUser, CurrentUser } from '../common/current-user.decorator';
import { AutoScoringPreferenceService } from './auto-scoring-preference.service';
import {
  AUTO_PREFERENCE_VALIDATION_PIPE,
  AutoScoringPreferenceCreateDto,
  AutoScoringPreferenceUpdateDto,
} from './dto/auto-scoring-preference.dto';
import { AutoCandidatesService } from './auto-candidates.service';
import { AUTO_CANDIDATES_VALIDATION_PIPE, AutoCandidatesDto } from './dto/auto-candidates.dto';

@Controller('auto-scoring')
export class AutoScoringController {
  constructor(
    private readonly preferences: AutoScoringPreferenceService,
    private readonly candidates: AutoCandidatesService,
  ) {}

  @Post('rank')
  rank(
    @CurrentUser() user: AuthenticatedUser,
    @Body(AUTO_CANDIDATES_VALIDATION_PIPE) dto: AutoCandidatesDto,
  ): Promise<AutoScoringResult> {
    return this.candidates.rank(user.userId, dto);
  }

  @Get('preferences')
  getPreferences(@CurrentUser() user: AuthenticatedUser): Promise<AutoScoringPreferenceRecord> {
    return this.preferences.get(user.userId);
  }

  @Post('preferences')
  createPreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body(AUTO_PREFERENCE_VALIDATION_PIPE) dto: AutoScoringPreferenceCreateDto,
  ): Promise<AutoScoringPreferenceRecord> {
    return this.preferences.create(user.userId, dto as AutoScoringPreferenceCreate);
  }

  @Put('preferences')
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body(AUTO_PREFERENCE_VALIDATION_PIPE) dto: AutoScoringPreferenceUpdateDto,
  ): Promise<AutoScoringPreferenceRecord> {
    return this.preferences.update(user.userId, dto as AutoScoringPreferenceUpdate);
  }
}
