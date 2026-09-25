import { memo } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { ApiChat } from '../../../api/types';

import { formatCountdownSeconds } from '../../../util/promo/countdownFormat';

import useLastCallback from '../../../hooks/useLastCallback';

import Avatar from '../../common/Avatar';
import Icon from '../../common/icons/Icon';

import styles from './PromoChatRow.module.scss';

type OwnProps = {
  chat: ApiChat;
  slowmodeRemaining: number;
};

const PromoChatRow = ({ chat, slowmodeRemaining }: OwnProps) => {
  const { openChat } = getActions();

  const handleClick = useLastCallback(() => {
    openChat({ id: chat.id });
  });

  const starsCost = chat.paidMessagesStars || 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      className={styles.row}
    >
      <Avatar peer={chat} size="medium" className={styles.avatar} />
      <div className={styles.title}>{chat.title}</div>
      {slowmodeRemaining > 0 && (
        <div className={styles.slowmodeBadge}>
          <Icon name="clock" className={styles.badgeIcon} />
          <span>{formatCountdownSeconds(slowmodeRemaining)}</span>
        </div>
      )}
      {starsCost > 0 && (
        <div className={styles.starsBadge}>
          <Icon name="star" className={styles.badgeIcon} />
          <span>{starsCost}</span>
        </div>
      )}
    </div>
  );
};

export default memo(PromoChatRow);
