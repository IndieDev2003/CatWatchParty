import axios from 'axios';
import React, { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Button } from 'semantic-ui-react';
import styles from './Announce.module.css';
import config from '../../config';

// const GITHUB_REPO = 'howardchung/watchparty-announcements';

type Issue = {
  title: string;
  body: string;
  number: number;
  updated_at: string;
};


// export default Announce;
